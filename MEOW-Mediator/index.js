// MEOW Mediator: genera el QR (HC1) desde Bundle/{id}/$meow y resuelve/decodifica QR MeOw
import express from 'express';
import axios from 'axios';
import 'dotenv/config';
import https from 'https';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Jimp } from 'jimp';
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

  // MEOW — operación $meow sobre Bundle/{id} (servicio firmador)
  MEOW_BASE_URL,
  MEOW_BASIC_USER,
  MEOW_BASIC_PASS,

  // MEOW — servicio de decodificación del HC1 (lacpass)
  MEOW_DECODE_URL = 'http://lacpass.create.cl:7089/decode/hcert',
  MEOW_DECODE_BASIC_USER,
  MEOW_DECODE_BASIC_PASS,

  // QR
  MEOW_QR_ERROR_CORRECTION = 'M',

  // Misceláneos
  CORS_ORIGIN,
  MEOW_PORT
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

// Requerir MEOW_BASE_URL en entorno para evitar hardcode
if (!MEOW_BASE_URL) {
  console.error('ENV error: MEOW_BASE_URL is required. Set MEOW_BASE_URL in your .env or environment.');
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
app.get(['/meow/health', '/meow/_health'], (req, res) => res.json({ status: 'ok' }));

// ====== helper para headers con Basic opcional (firmador MEOW) ======
function buildUpstreamJsonHeadersMeow() {
  const headers = { Accept: 'application/json, application/*+json, text/plain, */*' };
  if (MEOW_BASIC_USER && MEOW_BASIC_PASS) {
    const basic = Buffer.from(`${MEOW_BASIC_USER}:${MEOW_BASIC_PASS}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

// ====== helper para headers con Basic opcional (servicio de decode lacpass) ======
function buildUpstreamJsonHeadersDecode() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, application/*+json, text/plain, */*' };
  if (MEOW_DECODE_BASIC_USER && MEOW_DECODE_BASIC_PASS) {
    const basic = Buffer.from(`${MEOW_DECODE_BASIC_USER}:${MEOW_DECODE_BASIC_PASS}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

// Extrae los HC1 (attachment.data) de un Bundle batch-response del $meow
function extractHc1FromMeowResponse(meowBundle) {
  const entries = Array.isArray(meowBundle?.entry) ? meowBundle.entry : [];
  const out = [];
  for (const e of entries) {
    const resource = e?.resource;
    if (!resource || resource.resourceType !== 'DocumentReference') continue;
    const contents = Array.isArray(resource.content) ? resource.content : [];
    for (const c of contents) {
      const data = c?.attachment?.data;
      if (typeof data === 'string' && data.length > 0) {
        out.push({
          hc1: data,
          contentType: c?.attachment?.contentType || null,
          format: c?.format?.code || null
        });
      }
    }
  }
  return out;
}

/* =========================================================
 * 1) MEOW — generar QR desde $meow por Bundle
 *    POST /meow/_generate
 *    Body: Bundle FHIR (objeto o string), requiere Bundle.id
 *    Query: ?format=png  -> si hay un único resultado, responde la imagen PNG directa
 *    Env: MEOW_BASE_URL (required, e.g. https://signer.nodonacionalph4h-dev.minsal.cl/fhir)
 *         MEOW_BASIC_USER / MEOW_BASIC_PASS (opcional)
 * =======================================================*/
app.post('/meow/_generate', async (req, res) => {
  try {
    // 1.1) Parseo y validación
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

    // 1.2) Invocar $meow: GET /Bundle/{bundleId}/$meow
    const base = MEOW_BASE_URL.replace(/\/$/, ''); // sin trailing slash
    const url = `${base}/Bundle/${encodeURIComponent(bundleId)}/$meow`;
    const upstream = await axios.get(url, {
      headers: buildUpstreamJsonHeadersMeow(),
      responseType: 'json',
      timeout: 45000
    });

    // 1.3) Extraer HC1(s) de la respuesta (Bundle batch-response con DocumentReference)
    const hc1Entries = extractHc1FromMeowResponse(upstream?.data);
    if (hc1Entries.length === 0) {
      return res.status(502).json({ error: 'No MeOw QR (HC1) found in $meow response', detail: upstream?.data });
    }

    // 1.4) Generar imagen QR (PNG) por cada HC1
    const results = [];
    for (const item of hc1Entries) {
      const pngBuffer = await QRCode.toBuffer(item.hc1, {
        type: 'png',
        errorCorrectionLevel: MEOW_QR_ERROR_CORRECTION,
        margin: 2
      });
      results.push({
        hc1: item.hc1,
        contentType: item.contentType,
        format: item.format,
        qrCodeDataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
        _pngBuffer: pngBuffer
      });
    }

    // 1.5) Si piden PNG y hay un único resultado, devolver la imagen directamente
    if (req.query.format === 'png' && results.length === 1) {
      res.type('image/png');
      return res.send(results[0]._pngBuffer);
    }

    // 1.6) Respuesta JSON por defecto
    return res.status(200).json({
      bundleId,
      meowOperation: '$meow',
      count: results.length,
      results: results.map(({ _pngBuffer, ...rest }) => rest)
    });
  } catch (e) {
    console.error('❌ ERROR /meow/_generate:', e?.message || e);
    const status = e?.response?.status || 502;
    const detail = e?.response?.data || e?.message || 'Bad Gateway';
    return res.status(status).json({ error: 'MEOW QR generation failed', detail });
  }
});

/* =========================================================
 * 2) MEOW — decodificar QR (imagen) y resolver contra lacpass
 *    POST /meow/_decode
 *    Body: { qrImage: "<base64 png/jpg, con o sin prefijo data:>" }
 *       o: { hc1: "HC1:..." }  (salta la lectura de imagen)
 *    Env: MEOW_DECODE_URL (default http://lacpass.create.cl:7089/decode/hcert)
 * =======================================================*/
app.post('/meow/_decode', async (req, res) => {
  try {
    let hc1 = req?.body?.hc1;

    // 2.1) Si no viene el HC1 directo, leer el QR desde la imagen
    if (!hc1) {
      const qrImage = req?.body?.qrImage;
      if (!qrImage || typeof qrImage !== 'string') {
        return res.status(400).json({ error: 'Missing qrImage (base64) or hc1 (string)' });
      }

      const base64Data = qrImage.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      const image = await Jimp.read(imageBuffer);
      const { data, width, height } = image.bitmap;
      const decoded = jsQR(new Uint8ClampedArray(data), width, height);

      if (!decoded || !decoded.data) {
        return res.status(422).json({ error: 'Could not decode QR from image' });
      }
      hc1 = decoded.data;
    }

    if (typeof hc1 !== 'string' || hc1.length === 0) {
      return res.status(400).json({ error: 'Invalid HC1 content' });
    }
    if (!hc1.startsWith('HC1:')) {
      console.warn('El contenido leído del QR no parece un HC1:', hc1.slice(0, 20));
    }

    // 2.2) Enviar el HC1 al servicio de decode (lacpass)
    const upstream = await axios.post(
      MEOW_DECODE_URL,
      { include_raw: true, qr_data: hc1 },
      { headers: buildUpstreamJsonHeadersDecode(), responseType: 'json', timeout: 45000 }
    );

    // 2.3) Exponer el resultado decodificado
    return res.status(200).json({
      hc1,
      decoded: upstream?.data
    });
  } catch (e) {
    console.error('❌ ERROR /meow/_decode:', e?.message || e);
    const status = e?.response?.status || 502;
    const detail = e?.response?.data || e?.message || 'Bad Gateway';
    return res.status(status).json({ error: 'MEOW QR decode failed', detail });
  }
});

// Arrancar server
const PORT = MEOW_PORT || 8018;
app.listen(PORT, () => {
  console.log(`MEOW Mediator listening on http://localhost:${PORT}`);
});
