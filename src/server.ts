import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const host = process.env.HOST ?? 'localhost';
    const apiKey = process.env.CINEPRO_API_KEY?.trim();
    if ((host === '0.0.0.0' || host === '::') && !apiKey) {
        throw new Error('CINEPRO_API_KEY is required when CinePro listens on a public interface');
    }
    // TMDB's read-access token is an alternative to its v3 API key.
    // OMSS builds v3 URLs with api_key, so translate only TMDB requests to bearer auth.
    const tmdbReadToken = process.env.TMDB_READ_ACCESS_TOKEN;
    if (!process.env.TMDB_API_KEY && tmdbReadToken) {
        const upstreamFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            if (url.origin !== 'https://api.themoviedb.org') return upstreamFetch(input, init);
            url.searchParams.delete('api_key');
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            headers.set('Authorization', `Bearer ${tmdbReadToken}`);
            return upstreamFetch(url, { ...init, headers, redirect: 'error' });
        };
    }

    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host,
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: (process.env.CACHE_TYPE as 'memory' | 'redis') ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD
            }
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY ?? (tmdbReadToken ? 'tmdb-bearer-adapter' : ''),
            cacheTTL: 24 * 60 * 60 // 24h
        },

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies,
            streamPatterns
        },

        cors: {
            origin: process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean)
                ?? ['http://127.0.0.1:5173', 'http://localhost:5173'],
            methods: ['GET', 'HEAD', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        },

        stremio: {
            // exposes a stremio addon on /stremio/manifest.json
            enableNativeAddon: process.env.STREMIO_ADDON === 'true',
            // you can your own custom stremio addons as sources into cinepro.
            stremioAddons: []
            /*
            stremioAddons: [
                {
                    id: 'some-unique-id',
                    url: 'https://example.com/manifest.json',
                    enabled: true
                }
            ]
            */
        },

        // MCP for AI agents
        mcp: {
            enabled: process.env.MCP_ENABLED === 'true'
        }
    });

    // Health checks remain public; every other Core endpoint requires a server-side key.
    server.getInstance().addHook('onRequest', (request, reply, done) => {
        if (!apiKey || request.method === 'OPTIONS' ||
            (request.method === 'GET' && ['/', '/v1', '/v1/', '/v1/health'].includes(request.url.split('?')[0]))) {
            done();
            return;
        }
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${apiKey}`);
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
            done();
            return;
        }
        reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'));

    // Local trial: one unresponsive provider must not hold up every usable source.
    for (const provider of registry.getProviders()) {
        for (const method of ['getMovieSources', 'getTVSources'] as const) {
            const original = provider[method].bind(provider);
            provider[method] = (media) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve({
                    sources: [], subtitles: [], diagnostics: [{
                        code: 'PROVIDER_ERROR', severity: 'warning', field: '',
                        message: `${provider.name}: exceeded the local 30 second limit`
                    }]
                }), 30000);
                original(media).then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
            });
        }
    }

    await server.start();

    const publicUrl =
        process.env.PUBLIC_URL ??
        `http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`;

    const uiUrl = `https://ui.cinepro.cc/?omssurl=${encodeURIComponent(publicUrl)}`;

    const title = '🚀 CinePro/ui is in public testing';
    const contrib =
        '🤝 We are looking for contributors to improve and develop!';
    const repo = 'Contribute: https://github.com/cinepro-org/ui';
    const tryIt = `🌐 Try it out: ${uiUrl} !`;
    const note =
        'You will need to give the website "access to local applications" that it works.';

    const lines = [title, '', repo, '', contrib, '', tryIt, '', note];

    // compute box width based on longest line
    const width = Math.max(...lines.map((l) => l.length)) + 2;

    const borderTop = '╭' + '─'.repeat(width) + '╮';
    const borderBottom = '╰' + '─'.repeat(width) + '╯';

    const pad = (line: string) => '│ ' + line.padEnd(width - 2, ' ') + ' │';

    console.log(`
================== CINEPRO BETA ANNOUNCEMENT ==================

${borderTop}
${lines.map(pad).join('\n')}
${borderBottom}
`);
}

main().catch(error => {
    console.error('[CinePro] Startup failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
});
