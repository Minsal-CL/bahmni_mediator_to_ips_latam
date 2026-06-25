// VHL Generator Mediator + ICVP-from-Bundle
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';

const requireJson = createRequire(import.meta.url);
const mediatorConfig = requireJson('./mediatorConfig.json');

// ======== ENV ========
const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  NODE_ENV,

  // VHL
  VHL_ISSUANCE_URL,
  VHL_PASSCODE = '1234',
  VHL_EXPIRES_DAYS = '30',
  VHL_BASIC_USER,
  VHL_BASIC_PASS,
  VHL_VALIDATION_URL,
  VHL_RECIPIENT,

  // ICVP (operación $icvp sobre Bundle/{id})
  ICVP_BASE_URL,
  ICVP_BASIC_USER,
  ICVP_BASIC_PASS,

  // Misceláneos
  CORS_ORIGIN,
  ICVP_PORT
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
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
}

// Registrar y latido
registerMediator(openhimConfig, mediatorConfig, (err) => {
  if (err) {
    console.error('Error registrando mediator en OpenHIM:', err);
    process.exit(1);
  }
  console.log('Mediator registrado en OpenHIM.');

  // Ensure channels exist or get updated on startup
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

// Requerir ICVP_BASE_URL en entorno para evitar hardcode
if (!ICVP_BASE_URL) {
  console.error('ENV error: ICVP_BASE_URL is required. Set ICVP_BASE_URL in your .env or environment.');
  process.exit(1);
}

// ======== App ========
const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS middleware (antes de rutas)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (CORS_ORIGIN) {
    const allowedOrigins = CORS_ORIGIN.split(',').map((o) => o.trim());
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
app.get(['/icvpcert/health', '/icvpcert/_health'], (req, res) => res.json({ status: 'ok' }));

// Helper: fecha de expiración ISO (ahora + días)
const isoPlusDays = (days = 30) =>
  new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();

// ====== helper para headers con Basic opcional (VHL) ======
function buildUpstreamJsonHeadersVHL() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, application/*+json, text/plain, */*'
  };
  if (VHL_BASIC_USER && VHL_BASIC_PASS) {
    const basic = Buffer.from(`${VHL_BASIC_USER}:${VHL_BASIC_PASS}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

// ====== helper para headers con Basic opcional (ICVP) ======
function buildUpstreamJsonHeadersICVP() {
  const headers = {
    Accept: 'application/json, application/*+json, text/plain, */*'
  };
  if (ICVP_BASIC_USER && ICVP_BASIC_PASS) {
    const basic = Buffer.from(`${ICVP_BASIC_USER}:${ICVP_BASIC_PASS}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}
/* =========================================================
 * 4) ICVP — generar respuestas $icvp por cada Immunization del Bundle
 *    POST /icvpcert/_from-bundle
 *    Body: Bundle FHIR (objeto o string)
 *    Env: ICVP_BASE_URL (required, e.g. https://signer.nodonacionalph4h-dev.minsal.cl/fhir)
 *         ICVP_BASIC_USER / ICVP_BASIC_PASS (opcional)
 * =======================================================*/
app.post('/icvpcert/_from-bundle', async (req, res) => {
  try {
    // 4.1) Parseo y validación
    let bundle = req.body;
    if (!bundle) {
      return res.status(400).json({ error: 'Missing Bundle' });
    }
    if (typeof bundle === 'string') {
      try {
        bundle = JSON.parse(bundle);
      } catch {
        return res.status(400).json({ error: 'Bundle must be valid JSON' });
      }
    }
    if (typeof bundle !== 'object' || bundle.resourceType !== 'Bundle') {
      return res.status(400).json({ error: 'Body must be a FHIR Bundle object' });
    }
    const bundleId = bundle.id;
    if (!bundleId || typeof bundleId !== 'string') {
      return res.status(400).json({ error: 'Bundle.id is required (string)' });
    }

    // 4.2) Extraer Immunization.id
    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    const immunizationIds = entries
      .map((e) => e?.resource)
      .filter((r) => r && r.resourceType === 'Immunization' && typeof r.id === 'string' && r.id.length > 0)
      .map((r) => r.id);

    if (immunizationIds.length === 0) {
      return res.status(200).json({
        bundleId,
        immunizationIds: [],
        results: [],
        message: 'No Immunization resources found in the Bundle.'
      });
    }

    // 4.3) Preparar llamadas GET /Bundle/{bundleId}/$icvp?immunizationId={id}
    const base = ICVP_BASE_URL.replace(/\/$/, ''); // sin trailing slash
    const headers = buildUpstreamJsonHeadersICVP();

    const calls = immunizationIds.map((immId) => {
      const url = `${base}/Bundle/${encodeURIComponent(bundleId)}/$icvp?immunizationId=${encodeURIComponent(immId)}`;
      return axios
        .get(url, { headers, responseType: 'json', timeout: 45000 })
        .then((resp) => ({
          immunizationId: immId,
          status: resp?.status ?? 200,
          ok: true,
          data: resp?.data
        }))
        .catch((err) => ({
          immunizationId: immId,
          ok: false,
          status: err?.response?.status || 502,
          error: err?.response?.data || err?.message || 'Bad Gateway'
        }));
    });

    // 4.4) Ejecutar en paralelo (sin romper por una que falle)
    const settled = await Promise.allSettled(calls);
    const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason));

    // 4.5) Respuesta compacta
    return res.status(200).json({
      bundleId,
      icvpOperation: '$icvp',
      immunizationIds,
      results
    });
  } catch (e) {
    console.error('❌ ERROR /icvpcert/_from-bundle:', e?.message || e);
    const status = e?.response?.status || 502;
    const detail = e?.response?.data || e?.message || 'Bad Gateway';
    return res.status(status).json({ error: 'ICVP batch failed', detail });
  }
});

// Arrancar server
const PORT = ICVP_PORT || 8013;
app.listen(PORT, () => {
  console.log(`Mediator listening on http://localhost:${PORT}`);
});
