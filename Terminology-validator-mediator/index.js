// index.js — Terminology Mediator (GET helpers + proxy)
/* eslint-disable no-console */
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { createRequire } from 'module';
//import { v4 as uuidv4 } from 'uuid';
import { randomUUID } from 'crypto';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// ===================== ENV =====================
const {
  // OpenHIM
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,

  // Terminology server base (elige uno)
  TERMINOLOGY_BASE_URL,
  TERMINO_SERVER_URL,

  // Opcionales
  NODE_ENV,
  PORT_TERMINO,
  TERMINO_PORT,
  CORS_ORIGIN,
  TS_TIMEOUT_MS = '15000',
  TS_DISPLAY_LANGUAGE,
  TERMINO_BEARER_TOKEN,
  TERMINO_BASIC_USER,
  TERMINO_BASIC_PASS,
} = process.env;

// ===================== App base =====================
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS opcional
if (CORS_ORIGIN) {
  const allow = String(CORS_ORIGIN)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Correlation-id simple
app.use((req, _res, next) => {
  //req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = req.headers['x-correlation-id'] || randomUUID();
  next();
});

// Self-signed en DEV
if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠ DEV MODE: accepting self-signed certificates');
}

// ===================== OpenHIM =====================
if (OPENHIM_API && OPENHIM_USER && OPENHIM_PASS) {
  const openhimConfig = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn,
  };
  registerMediator(openhimConfig, mediatorConfig, (err) => {
    if (err) {
      console.error('❌ OpenHIM registration error:', err.message || err);
      process.exit(1);
    }
    console.log('✅ Mediator registered with OpenHIM');

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
}

// ===================== TS axios client =====================
//const TS_BASE_URL = (TERMINO_SERVER_URL || TERMINO_SERVER_URL || '').replace(/\/+$/, '');
const TS_BASE_URL = (process.env.TERMINOLOGY_BASE_URL || process.env.TERMINO_SERVER_URL || '').replace(/\/+$/, '');
if (!TS_BASE_URL) {
  console.warn('⚠ TERMINOLOGY_BASE_URL/TERMINO_SERVER_URL no está configurado. Solo /_health responderá OK.');
}

function buildTsClient() {
  if (!TS_BASE_URL) return null;
  const headers = { Accept: 'application/fhir+json' };
  if (TERMINO_BEARER_TOKEN) headers.Authorization = `Bearer ${TERMINO_BEARER_TOKEN}`;
  const auth = (TERMINO_BASIC_USER && TERMINO_BASIC_PASS)
    ? { username: TERMINO_BASIC_USER, password: TERMINO_BASIC_PASS }
    : undefined;

  return axios.create({
    baseURL: TS_BASE_URL,
    timeout: parseInt(TS_TIMEOUT_MS, 10) || 15000,
    headers,
    auth,
    httpsAgent: axios.defaults.httpsAgent,
    validateStatus: () => true, // devolvemos el status upstream tal cual
  });
}

const ax = buildTsClient();

// ===================== Health =====================
app.get('/termino/_health', (_req, res) => {
  res.status(200).json({ status: 'ok', tsBase: TS_BASE_URL || null });
});

// ===================== Helpers GET→POST $operation =====================
function paramsFromQuery(query, spec) {
  // spec = [{ q:'system', type:'uri', name:'system' }, ...]
  const p = [];
  for (const { q, type, name } of spec) {
    const raw = query[q];
    if (raw == null) continue;
    const v = Array.isArray(raw) ? raw[0] : raw; // usamos 1ro si vienen repetidos
    const fhirName = name || q;
    const key = type === 'uri' ? 'valueUri'
             : type === 'code' ? 'valueCode'
             : /*string*/       'valueString';
    p.push({ name: fhirName, [key]: String(v) });
  }
  // azúcar: si no llega displayLanguage y hay default global
  if (!query.displayLanguage && TS_DISPLAY_LANGUAGE) {
    p.push({ name: 'displayLanguage', valueCode: TS_DISPLAY_LANGUAGE });
  }
  return { resourceType: 'Parameters', parameter: p };
}

async function forwardTsOperation(axClient, path, parameters, req, res) {
  if (!axClient) {
    return res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'processing', diagnostics: 'TS base URL not configured' }],
    });
  }
  try {
    const { data, status } = await axClient.post(path, parameters, {
      headers: {
        'Content-Type': 'application/fhir+json',
        'X-Correlation-ID': req.correlationId,
      },
    });
    res.status(status || 200).json(data);
  } catch (e) {
    const status = e?.response?.status || 502;
    const diag = e?.response?.data || e?.message || 'TS upstream error';
    res.status(status).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'processing', diagnostics: JSON.stringify(diag) }],
    });
  }
}

// ===================== Rutas GET “compatibles” con FHIR =====================
// 1) CodeSystem $lookup
app.get('/termino/fhir/CodeSystem/$lookup', async (req, res) => {
  const spec = [
    { q: 'system', type: 'uri' },       // http://snomed.info/sct
    { q: 'code', type: 'code' },        // 59621000
    { q: 'version', type: 'uri' },      // http://snomed.info/sct/900.../version/20250501
    { q: 'displayLanguage', type: 'code' },
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ax, '/CodeSystem/$lookup', params, req, res);
});

// 2) CodeSystem $validate-code (forma recomendada con url=CodeSystem)
app.get('/termino/fhir/CodeSystem/$validate-code', async (req, res) => {
  const spec = [
    { q: 'url', type: 'uri' },          // p.ej. http://snomed.info/sct
    { q: 'version', type: 'uri' },      // p.ej. http://snomed.info/sct/900.../version/20250501
    { q: 'code', type: 'code' },
    { q: 'display', type: 'string' },
    { q: 'displayLanguage', type: 'code' },
  ];
  // azúcar: permitir ?system=... en vez de ?url=...
  if (req.query.system && !req.query.url) req.query.url = req.query.system;
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ax, '/CodeSystem/$validate-code', params, req, res);
});

// 3) ValueSet $validate-code (por si validas contra VS)
app.get('/termino/fhir/ValueSet/$validate-code', async (req, res) => {
  const spec = [
    { q: 'url', type: 'uri' },          // VS URL (incluye ECL VS si aplica)
    { q: 'system', type: 'uri' },
    { q: 'code', type: 'code' },
    { q: 'display', type: 'string' },
    { q: 'displayLanguage', type: 'code' },
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ax, '/ValueSet/$validate-code', params, req, res);
});

// 4) ConceptMap $translate (p.ej. vacunas → ICD11/PreQual)
app.get('/termino/fhir/ConceptMap/$translate', async (req, res) => {
  const spec = [
    { q: 'url', type: 'uri' },          // ConceptMap directo, opcional
    { q: 'system', type: 'uri' },       // source system
    { q: 'code', type: 'code' },
    { q: 'source', type: 'uri' },       // source VS
    { q: 'target', type: 'uri' },       // target VS
    { q: 'targetsystem', type: 'uri' }, // target system
    { q: 'displayLanguage', type: 'code' },
  ];
  const params = paramsFromQuery(req.query, spec);
  return forwardTsOperation(ax, '/ConceptMap/$translate', params, req, res);
});

// ===================== Proxy genérico (catch-all) =====================
// Todo lo demás bajo /termino/fhir/** se reenvía tal cual al TS
app.use('/termino/fhir', async (req, res) => {
  if (!ax) {
    return res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'processing', diagnostics: 'TS base URL not configured' }],
    });
  }
  try {
    // Reconstruir la ruta aguas arriba sin el prefijo /termino/fhir
    const upstreamPath = req.originalUrl.replace(/^\/termino\/fhir/, '');
    const url = `${TS_BASE_URL}${upstreamPath}`;

    console.log(`[${req.correlationId}] → TS ${req.method} ${url}`);

    const headers = {
      ...req.headers,
      'X-Correlation-ID': req.correlationId,
    };
    // No reenviar hop-by-hop ni host
    delete headers.host;
    delete headers['content-length'];

    const { data, status, headers: respHeaders } = await axios({
      method: req.method,
      url,
      data: req.body,
      headers,
      httpsAgent: axios.defaults.httpsAgent,
      validateStatus: () => true,
    });

    // Propaga status y payload; filtramos headers problemáticos
    Object.entries(respHeaders || {}).forEach(([k, v]) => {
      const lk = String(k).toLowerCase();
      if (['transfer-encoding', 'content-length', 'connection'].includes(lk)) return;
      res.setHeader(k, v);
    });

    res.status(status || 200).send(data);
  } catch (e) {
    const status = e?.response?.status || 502;
    const diag = e?.response?.data || e?.message || 'TS proxy error';
    console.error('❌ TS proxy error:', e?.message || e);
    res.status(status).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'processing', diagnostics: JSON.stringify(diag) }],
    });
  }
});

// ===================== Start =====================
const PORT = TERMINO_PORT || PORT_TERMINO || 8010;
app.listen(PORT, () => {
  console.log(`Terminology Mediator listening on port ${PORT}`);
  console.log(`→ TS base: ${TS_BASE_URL || '(not configured)'}`);
});
