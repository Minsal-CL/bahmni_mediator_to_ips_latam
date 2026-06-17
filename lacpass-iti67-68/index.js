import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

const {
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODO_REGIONAL_SERVER,
  NODE_ENV,
  LACPASS_MEDIATOR_PORT,
  CORS_ORIGIN // origen permitido (ej: https://TU-BAHMNI)
} = process.env;

const openhimConfig = {
  username: OPENHIM_USER,
  password: OPENHIM_PASS,
  apiURL: OPENHIM_API,
  trustSelfSigned: true,
  urn: mediatorConfig.urn
};

if (NODE_ENV === 'development') {
  axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  console.log('⚠️ DEV MODE: self-signed certs accepted');
}

registerMediator(openhimConfig, mediatorConfig, err => {
  if (err) {
    console.error('❌ Registration error:', err);
    process.exit(1);
  }
  activateHeartbeat(openhimConfig);
});

const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS middleware (antes de rutas)
const allowedOrigins = CORS_ORIGIN
  ? CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (origin && allowedOrigins.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-OpenHIM-ClientID'
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-OpenHIM-TransactionID');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// function requireAuthorization(req, res, next) {
//     if (!req.headers.authorization) {
//         return res.status(401).json({ error: 'Authorization header required' });
//     }
//     next();
// }

// normalize base FHIR endpoint
function fhirBase() {
  let base = FHIR_NODO_REGIONAL_SERVER || '';
  base = base.replace(/\/+$/, '');
  if (!base.toLowerCase().includes('/fhir')) {
    base = `${base}/fhir`;
  }
  return base.replace(/\/+$/, '');
}

// logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} query=`, req.query, 'body=', req.body);
  next();
});

// health (no auth assumption; OpenHIM can gatekeep)
app.get('/regional/_health', (_req, res) => res.status(200).send('OK'));

// Transparent passthrough for DocumentReference search (ITI-67 semantics)
app.get('/regional/DocumentReference', async (req, res) => {
  try {
  // forward all query params, asegurando escape de '*' como '%2A'
    const params = { ...req.query };
    if (typeof params['patient.identifier'] === 'string') {
      params['patient.identifier'] = params['patient.identifier'].replace(/\*/g, '%2A');
    }
    const url = `${fhirBase()}/DocumentReference`;
    const forwardHeaders = { Accept: 'application/fhir+json' };
    //if (req.headers && req.headers.authorization) {
   //   forwardHeaders.Authorization = req.headers.authorization;
   // }

    const response = await axios.get(url, {
      params,
      headers: forwardHeaders,
      httpsAgent: axios.defaults.httpsAgent,
      timeout: 60000
    });
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('❌ Error proxying DocumentReference:', e.response?.data || e.message);
    const errBody = e.response?.data || { message: e.message };
    res.status(e.response?.status || 500).json(errBody);
  }
});

// Transparent passthrough for Bundle retrieval (ITI-68 semantics)
app.get('/regional/Bundle/:id', async (req, res) => {
  try {
    const url = `${fhirBase()}/Bundle/${encodeURIComponent(req.params.id)}`;
    const forwardHeaders = { Accept: 'application/fhir+json' };
    //if (req.headers && req.headers.authorization) {
    //  forwardHeaders.Authorization = req.headers.authorization;
    //}

    const response = await axios.get(url, {
      params: { _format: 'json', ...req.query },
      headers: forwardHeaders,
      httpsAgent: axios.defaults.httpsAgent,
      timeout: 60000
    });
    res.status(response.status).json(response.data);
  } catch (e) {
    console.error('❌ Error proxying Bundle:', e.response?.data || e.message);
    const errBody = e.response?.data || { message: e.message };
    res.status(e.response?.status || 500).json(errBody);
  }
});

// start
const PORT = process.env.LACPASS_MEDIATOR_PORT || 8006;
app.listen(PORT, '0.0.0.0', () => console.log(`Mediator listening on port ${PORT}`));

