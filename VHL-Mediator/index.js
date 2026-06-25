// VHL Generator Mediator
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import https from 'https';
import {registerMediator, activateHeartbeat} from 'openhim-mediator-utils';
import {createRequire} from 'module';

const requireJson = createRequire(import.meta.url);
const mediatorConfig = requireJson('./mediatorConfig.json');

// ======== ENV ========
const {
    OPENHIM_USER,
    OPENHIM_PASS,
    OPENHIM_API,
    NODE_ENV,
    VHL_ISSUANCE_URL,
    VHL_PASSCODE = '1234',
    VHL_EXPIRES_DAYS = '30',
    VHL_BASIC_USER,
    VHL_BASIC_PASS,
    CORS_ORIGIN,
    VHL_VALIDATION_URL
} = process.env;

// ======== OpenHIM mediator registration ========
const openhimConfig = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn
};

// Permitir self-signed en dev
if (NODE_ENV === 'development') {
    axios.defaults.httpsAgent = new https.Agent({rejectUnauthorized: false});
}

// Registrar y latido
registerMediator(openhimConfig, mediatorConfig, (err) => {
        if (err) {
                console.error('Error registrando mediator en OpenHIM:', err);
                process.exit(1);
        }
        console.log('Mediator registrado en OpenHIM.');

        const auth = { username: openhimConfig.username, password: openhimConfig.password };
        const channels = mediatorConfig.defaultChannelConfig || [];

        Promise.all(
            channels.map(ch =>
                axios.post(`${openhimConfig.apiURL}/channels`, { ...ch, mediator_urn: mediatorConfig.urn }, { auth })
                    .then(() => console.log(`✅ Channel created: ${ch.name}`))
                    .catch(async (e) => {
                        const msg = e?.response?.data || e?.message || e.toString();
                        if (String(msg).toLowerCase().includes('duplicate') || e?.response?.status === 409) {
                            try {
                                const q = encodeURIComponent(ch.name);
                                const res = await axios.get(`${openhimConfig.apiURL}/channels?name=${q}`, { auth });
                                const existing = Array.isArray(res.data) ? res.data[0] : res.data;
                                const id = existing && (existing._id || existing.id || existing.channelId || existing._uid);
                                if (id) {
                                    await axios.put(`${openhimConfig.apiURL}/channels/${id}`, { ...ch, mediator_urn: mediatorConfig.urn }, { auth });
                                    console.log(`♻️ Channel updated: ${ch.name}`);
                                } else {
                                    console.log(`ℹ️ Channel exists but id unknown: ${ch.name}`);
                                }
                            } catch (uerr) {
                                console.error(`❌ Updating channel ${ch.name} failed:`, uerr?.response?.data || uerr?.message || uerr);
                            }
                        } else {
                            console.error(`❌ Channel ${ch.name} error:`, msg);
                        }
                    })
            )
        ).then(() => {
            console.log('✅ All channels processed');
            activateHeartbeat(openhimConfig);
        });
});

// ======== App ========
const app = express();
app.use(express.json({limit: '20mb'}));

// CORS middleware (antes de rutas)
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (CORS_ORIGIN) {
        // convierte la lista de orígenes en un array
        const allowedOrigins = CORS_ORIGIN.split(',').map(o => o.trim());

        if (allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
    } else if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Salud
app.get('/vhl/_health', (req, res) => res.json({status: 'ok'}));

// Helper: fecha de expiración ISO (ahora + días)
const isoPlusDays = (days = 30) =>
    new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();



// POST /vhl/_generate
// Body: (Bundle FHIR) - objeto o string
app.post('/vhl/_generate', async (req, res) => {
    try {
        let bundle = req.body;
        if (!bundle) {
            return res.status(400).json({error: 'Missing IPS bundle'});
        }

        // Si vino como string, intenta parsear
        if (typeof bundle === 'string') {
            try {
                bundle = JSON.parse(bundle);
            } catch { /* lo dejamos como venía */
            }
        }

        // Validación mínima
        if (typeof bundle !== 'object' || bundle.resourceType !== 'Bundle') {
            return res.status(400).json({error: 'Body must be a FHIR Bundle object'});
        }

        // Armar payload para el servicio de emisión
        const payload = {
            expiresOn: isoPlusDays(VHL_EXPIRES_DAYS),
            jsonContent: JSON.stringify(bundle),
            passCode: VHL_PASSCODE
        };

        // Headers (con basic opcional)
        const headers = {'Content-Type': 'application/json'};
        if (VHL_BASIC_USER && VHL_BASIC_PASS) {
            const basic = Buffer.from(`${VHL_BASIC_USER}:${VHL_BASIC_PASS}`).toString('base64');
            headers.Authorization = `Basic ${basic}`;
        }

        // Llamada al emisor (retorna texto tipo "HC1: ...")
        const resp = await axios.post(VHL_ISSUANCE_URL, payload, {
            headers,
            responseType: 'text',
            timeout: 180000
        });

        const hc1 = (resp.data || '').toString().trim();
        if (!hc1.startsWith('HC1:')) {
            console.warn('Respuesta del emisor no parece HC1:', hc1.slice(0, 20));
        }

        // Devuelve JSON limpio
        return res.json({hc1});
    } catch (e) {
        console.error('❌ ERROR /vhl/_generate:', e?.message || e);
        const status = e?.response?.status || 502;
        const detail = e?.response?.data || e?.message || 'Bad Gateway';
        return res.status(status).json({error: 'VHL issuance failed', detail});
    }
});

app.post('/vhl/_validate', async (req, res) => {
    try {
        const qrCodeContent = req?.body?.qrCodeContent;
        if (!qrCodeContent || typeof qrCodeContent !== 'string') {
            return res.status(400).json({error: 'Missing qrCodeContent (HC1 string)'});
        }

        const headers = {'Content-Type': 'application/json', Accept: 'application/json'};
        // Auth opcional hacia el servicio de validación
        if (process.env.VHL_BASIC_USER && process.env.VHL_BASIC_PASS) {
            const basic = Buffer.from(`${process.env.VHL_BASIC_USER}:${process.env.VHL_BASIC_PASS}`).toString('base64');
            headers.Authorization = `Basic ${basic}`;
        }

        const upstream = await axios.post(
            VHL_VALIDATION_URL,
            {qrCodeContent},
            {headers, responseType: 'json', timeout: 180000}
        );

        const data = upstream?.data || {};
        const url = data?.shLinkContent?.url || null;

        // Si hay URL y el cliente quiere texto (o ?format=text), devolvemos SOLO la URL
        const wantsText =
            (req.query.format === 'text') ||
            (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/plain'));

        if (url && wantsText) {
            res.type('text/plain; charset=utf-8');
            return res.send(url);
        }

        // Si hay URL pero no pidió texto: JSON compacto útil
        if (url) {
            return res.status(200).json({
                url,
                shLinkContent: data.shLinkContent,
                validationStatus: data.validationStatus
            });
        }

        // Si no hay URL, pasamos la respuesta original
        return res.status(200).json(data);
    } catch (e) {
        console.error('❌ ERROR /vhl/_validate:', e?.message || e);
        const status = e?.response?.status || 502;
        const detail = e?.response?.data || e?.message || 'Bad Gateway';
        return res.status(status).json({error: 'VHL validation failed', detail});
    }
});

// ====== helper para headers con Basic opcional ======
function buildUpstreamJsonHeaders() {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, application/*+json, text/plain, */*' };
    if (process.env.VHL_BASIC_USER && process.env.VHL_BASIC_PASS) {
        const basic = Buffer.from(`${process.env.VHL_BASIC_USER}:${process.env.VHL_BASIC_PASS}`).toString('base64');
        headers.Authorization = `Basic ${basic}`;
    }
    return headers;
}

function getUpstreamTimeoutMs() {
    const raw = process.env.VHL_UPSTREAM_TIMEOUT_MS;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 180000;
}

function rewriteManifestUrlIfNeeded(manifestUrl) {
    const baseOverride = process.env.VHL_MANIFEST_BASE_URL;
    if (baseOverride) {
        const original = new URL(manifestUrl);
        const base = new URL(baseOverride);
        base.pathname = original.pathname;
        base.search = original.search;
        base.hash = original.hash;
        return base.toString();
    }

    const from = process.env.VHL_MANIFEST_URL_REWRITE_FROM;
    const to = process.env.VHL_MANIFEST_URL_REWRITE_TO;
    if (from && to && manifestUrl.startsWith(from)) {
        return to + manifestUrl.slice(from.length);
    }

    return manifestUrl;
}

app.post('/vhl/_resolve', async (req, res) => {
    const debugContext = {
        validationUrl: process.env.VHL_VALIDATION_URL || null,
        manifestUrlOriginal: null,
        manifestUrlUsed: null
    };

    try {
        const qrCodeContent = req?.body?.qrCodeContent;
        if (!qrCodeContent || typeof qrCodeContent !== 'string') {
            return res.status(400).json({ error: 'Missing qrCodeContent (HC1 string)' });
        }

        if (!process.env.VHL_VALIDATION_URL) {
            return res.status(500).json({ error: 'VHL resolve misconfigured', detail: 'Missing VHL_VALIDATION_URL env var' });
        }

        const upstreamTimeoutMs = getUpstreamTimeoutMs();

        // 1) Validar HC1 -> obtener manifest URL
        const validationResp = await axios.post(
            process.env.VHL_VALIDATION_URL,
            { qrCodeContent },
            { headers: buildUpstreamJsonHeaders(), responseType: 'json', timeout: upstreamTimeoutMs }
        );

        const validation = validationResp?.data || {};
        debugContext.manifestUrlOriginal = validation?.shLinkContent?.url || null;
        if (!debugContext.manifestUrlOriginal || typeof debugContext.manifestUrlOriginal !== 'string') {
            return res.status(400).json({
                error: 'Validation succeeded but manifest URL is missing',
                detail: validation?.validationStatus || null
            });
        }

        debugContext.manifestUrlUsed = rewriteManifestUrlIfNeeded(debugContext.manifestUrlOriginal);
        if (debugContext.manifestUrlUsed !== debugContext.manifestUrlOriginal) {
            console.log('ℹ️  Manifest URL rewritten:', { from: debugContext.manifestUrlOriginal, to: debugContext.manifestUrlUsed });
        } else {
            console.log('ℹ️  Manifest URL NOT rewritten:', { url: debugContext.manifestUrlOriginal });
        }

        // 2) POST al manifest con recipient + passcode
        const recipient = process.env.VHL_RECIPIENT || 'Bahmni Client';
        const passcode  = process.env.VHL_PASSCODE || '1234';

        console.log('➡️  POST manifest', { url: debugContext.manifestUrlUsed, timeoutMs: upstreamTimeoutMs });

        const manifestResp = await axios.post(
            debugContext.manifestUrlUsed,
            { recipient, passcode },
            { headers: buildUpstreamJsonHeaders(), responseType: 'json', timeout: upstreamTimeoutMs }
        );

        const manifestData = manifestResp?.data || {};
        const files = Array.isArray(manifestData?.files) ? manifestData.files : [];

        // negociación simple: text/plain => devuelve solo la URL si hay 1 archivo
        const wantsText =
            (req.query.format === 'text') ||
            (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/plain'));

        if (wantsText && files.length === 1 && files[0]?.location) {
            res.type('text/plain; charset=utf-8');
            return res.send(String(files[0].location));
        }

        // Por defecto, JSON compacto con files (+ contexto útil)
        return res.status(200).json({
            files,
            manifestUrl: debugContext.manifestUrlUsed,
            manifestUrlOriginal: debugContext.manifestUrlOriginal,
            validationStatus: validation?.validationStatus || null
        });
    } catch (e) {
        console.error('❌ ERROR /vhl/_resolve:', e?.message || e);
        const status = e?.response?.status || 502;
        const detail = e?.response?.data || e?.message || 'Bad Gateway';
        const debug = {
            upstreamUrl: e?.config?.url || null,
            upstreamMethod: e?.config?.method || null,
            code: e?.code || null,
            ...debugContext
        };
        return res.status(status).json({ error: 'VHL resolve failed', detail, debug });
    }
});


// Arrancar server
const PORT = process.env.VHL_PORT || 8008;
app.listen(PORT, () => {
    console.log(`VHL Mediator listening on http://localhost:${PORT}`);
});
