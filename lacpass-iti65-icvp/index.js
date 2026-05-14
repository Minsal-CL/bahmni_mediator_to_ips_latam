// index.js — LACPASS → ITI-65 Mediator con PDQm + Terminología por dominio
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// ===================== ICVP / Vaccine System (hardcoded) =====================
// System exigido para vaccineCode por el perfil ICVP (usar ICD-11 MMS)
const ICVP_VACCINE_SYSTEM = 'http://id.who.int/icd/release/11/mms';

// ===================== ENV =====================
const {
  // OpenHIM / FHIR Destino
  OPENHIM_USER,
  OPENHIM_PASS,
  OPENHIM_API,
  FHIR_NODE_URL,
  SUMMARY_ICVP_PROFILE,
  FHIR_NODO_NACIONAL_SERVER,

  NODE_ENV,
  DEBUG_DIR,

  // CORS
  CORS_ORIGIN,

  // ===== Features =====
  FEATURE_PDQ_ENABLED = 'true',
  FEATURE_TS_ENABLED = 'true',

  // Subfeatures terminológicas
  FEATURE_TS_EXPAND_ENABLED = 'false',
  FEATURE_TS_VALIDATE_VS_ENABLED = 'false',
  FEATURE_TS_VALIDATE_CS_ENABLED = 'false',
  FEATURE_TS_LOOKUP_ENABLED = 'true',
  FEATURE_TS_TRANSLATE_ENABLED = 'false',
  
  // Feature flag específico para vacunas (nuevo)
  // Si no está definida, por defecto queda habilitado (true) para no romper otros ambientes
  FEATURE_TS_VACCINES_ENABLED = 'true',

  // ===== OIDs para identificadores de paciente (desde tu .env) =====
  LAC_NATIONAL_ID_SYSTEM_OID,
  LAC_PASSPORT_ID_SYSTEM_OID,

  // ===== PDQm =====
  PDQM_PORT,
  PDQM_FHIR_URL,
  PDQM_FHIR_TOKEN,
  PDQM_TIMEOUT_MS = '10000',
  PDQM_ALLOWED_SEARCH_PARAMS,
  PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES,
  PDQM_DEFAULT_IDENTIFIER_SYSTEM,
  PDQM_FALLBACK_HTTP_STATUSES,
  PDQM_ENABLE_FALLBACK_FOR_401_403 = 'false',
  PDQM_ENABLE_ALIASES = 'true',

  // ===== Terminology =====
  // Acepta alias TERMINOLOGY_BASE_URL o TERMINO_SERVER_URL
  TERMINOLOGY_BASE_URL,
  TERMINO_SERVER_URL,
  TS_TIMEOUT_MS = '15000',
  TS_DISPLAY_LANGUAGE,
  TS_ACTIVE_ONLY = 'true',

  // Dominios
  TS_DOMAINS = 'conditions,procedures,medications',
  TS_DEFAULT_DOMAIN = 'conditions',

  // Defaults para $translate (si el dominio no define)
  TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL = '',
  TS_TRANSLATE_DEFAULT_SOURCE_VS = '',
  TS_TRANSLATE_DEFAULT_TARGET_VS = '',
  TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM = 'http://snomed.info/sct',
  TS_TRANSLATE_DEFAULT_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

  // Auth Terminology
  TERMINO_BEARER_TOKEN,
  TERMINO_BASIC_USER,
  TERMINO_BASIC_PASS,

  // ============ CONDITIONS ============
  CONDITIONS_VS_EXPAND_URI = '',
  CONDITIONS_VS_VALIDATE_URI = '',
  CONDITIONS_CS_URI = 'http://snomed.info/sct',
  CONDITIONS_TRANSLATE_CONCEPTMAP_URL = '',
  CONDITIONS_TRANSLATE_SOURCE_VS = '',
  CONDITIONS_TRANSLATE_TARGET_VS = '',
  CONDITIONS_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  CONDITIONS_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

  // ============ PROCEDURES ============
  PROCEDURES_VS_EXPAND_URI = '',
  PROCEDURES_VS_VALIDATE_URI = '',
  PROCEDURES_CS_URI = 'http://snomed.info/sct',
  PROCEDURES_TRANSLATE_CONCEPTMAP_URL = '',
  PROCEDURES_TRANSLATE_SOURCE_VS = '',
  PROCEDURES_TRANSLATE_TARGET_VS = '',
  PROCEDURES_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  PROCEDURES_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-pcs',

  // ============ MEDICATIONS ============
  MEDICATIONS_VS_EXPAND_URI = '',
  MEDICATIONS_VS_VALIDATE_URI = '',
  MEDICATIONS_CS_URI = 'http://snomed.info/sct',
  MEDICATIONS_TRANSLATE_CONCEPTMAP_URL = '',
  MEDICATIONS_TRANSLATE_SOURCE_VS = '',
  MEDICATIONS_TRANSLATE_TARGET_VS = '',
  MEDICATIONS_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  MEDICATIONS_TRANSLATE_TARGET_SYSTEM = 'http://www.whocc.no/atc',

  // ============ VACCINES ============
  VACCINES_VS_EXPAND_URI = '',
  VACCINES_VS_VALIDATE_URI = '',
  VACCINES_CS_URI = 'http://snomed.info/sct',
  VACCINES_TRANSLATE_CONCEPTMAP_URL = '',
  VACCINES_TRANSLATE_SOURCE_VS = '',
  VACCINES_TRANSLATE_TARGET_VS = '',
  VACCINES_TRANSLATE_SOURCE_SYSTEM = 'http://snomed.info/sct',
  VACCINES_TRANSLATE_TARGET_SYSTEM = 'http://hl7.org/fhir/sid/icd-10',

  // Nuevo: configuración para formatCode
  MHD_FORMAT_CODE = 'urn:ihe:iti:xds-sd:text:2008',
  MHD_FORMAT_SYSTEM = 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
  
  // Debug level para ops terminológicas
  TS_DEBUG_LEVEL = 'warn', // 'debug', 'warn', 'error', 'silent'
    // Feature para enviar solo vacunas (Composition/Patient/Immunization)
    FEATURE_ICVP_VACCINES_ONLY = 'false',
} = process.env;

// ====== NUEVO: separador configurable para URN OID (por defecto ".")
const OID_URN_SEPARATOR = process.env.OID_URN_SEPARATOR || '.';

const {
    ABSOLUTE_FULLURL_BASE: ENV_ABSOLUTE_FULLURL_BASE,
    FULLURL_MODE_DOCUMENT: ENV_FULLURL_MODE_DOCUMENT,
    FULLURL_MODE_PROVIDE: ENV_FULLURL_MODE_PROVIDE,
    ATTACHMENT_URL_MODE: ENV_ATTACHMENT_URL_MODE,
    BINARY_DELIVERY_MODE: ENV_BINARY_DELIVERY_MODE,
} = process.env;

const ABSOLUTE_FULLURL_BASE = ENV_ABSOLUTE_FULLURL_BASE;
const FULLURL_MODE_DOCUMENT = (ENV_FULLURL_MODE_DOCUMENT || 'urn').toLowerCase();
const FULLURL_MODE_PROVIDE = (ENV_FULLURL_MODE_PROVIDE || 'absolute').toLowerCase();
const ATTACHMENT_URL_MODE = (ENV_ATTACHMENT_URL_MODE || 'urn').toLowerCase();
const BINARY_DELIVERY_MODE = (ENV_BINARY_DELIVERY_MODE || 'both').toLowerCase();

// -----------------------------------------------------------------------------
// Normaliza bases FHIR absolutas sin imponer sufijos adicionales.
// -----------------------------------------------------------------------------
function normalizeFhirBase(url) {
    let base = String(url || '').trim();
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    return base.replace(/\/+$/, '');
}

function asAbsoluteBase(base) {
    return String(base || '').replace(/\/+$/, '');
}

//const ABSOLUTE_FULLURL_BASE = normalizeFhirBase(
//    ENV_ABSOLUTE_FULLURL_BASE || process.env.FHIR_NODO_REGIONAL_SERVER || 'http://127.0.0.1:8080/fhir/1'
//);

// Prevent rebuilding absolute references from req.headers.host in downstream helpers.

// ===== Constantes de Perfiles y Códigos =====
// OIDs por defecto (normalizados a urn:oid con separador configurable)
const DEFAULT_NAT_OID = toUrnOid(LAC_NATIONAL_ID_SYSTEM_OID || '2.16.152');
const DEFAULT_PPN_OID = toUrnOid(LAC_PASSPORT_ID_SYSTEM_OID || '2.16.840.1.113883.4.330.152');

// Perfiles IPS (http)
const IPS_PROFILES = {
    BUNDLE: 'http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP|0.2.0',
    MEDICATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Medication-uv-ips',
    MEDICATION_REQUEST: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips',
    COMPOSITION: 'http://smart.who.int/trust-phw/StructureDefinition/Composition-uv-ips-ICVP',
    PATIENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips',
    ALLERGY_INTOLERANCE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips',
    CONDITION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips',
    MEDICATION_STATEMENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips',
    PROCEDURE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips',
    IMMUNIZATION: 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP',
    OBSERVATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-uv-ips'
};

// Códigos LOINC para secciones IPS
const LOINC_CODES = {
    ALLERGIES_SECTION: '48765-2',
    PROBLEMS_SECTION: '11450-4',
    MEDICATIONS_SECTION: '10160-0',
    PAST_ILLNESS_SECTION: '11348-0',
    IMMUNIZATIONS_SECTION: '11369-6',
    PROCEDURES_SECTION: '47519-4',
    RESULTS_SECTION: '30954-2'
};

// Perfiles ICVP (racsel) — coinciden con el validador
const LAC_PROFILES = {
    BUNDLE: 'http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP|0.2.0',
    COMPOSITION: 'http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP',
    IMMUNIZATION: 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP',
    PATIENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips'
};

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// --- SNOMED $lookup (solo consulta, sin usar respuesta) -----------------------
const SNOMED_SYSTEM = 'http://snomed.info/sct';
const LOOKUP_SNOMED_ONLY = String(process.env.LOOKUP_SNOMED_ONLY || 'false').toLowerCase() === 'true';

async function fireAndForgetSnomedLookup(ts, system, code, versionUri) {
  if (!ts || !system || !code) return;
  try {
    // SOLO CONSULTA: CodeSystem/$lookup (no usamos la respuesta)
    await ts.get('/CodeSystem/$lookup', {
      params: {
        system,                   // http://snomed.info/sct
        code,                     // p.ej. 59621000
        version: versionUri,      // p.ej. http://snomed.info/sct/900000000000207008/version/20240331
        _format: 'json'
      }
    });
  } catch (e) {
    // Log no bloqueante (usar WARN para que se vea con TS_DEBUG_LEVEL=warn)
    tsLog('warn', `SNOMED $lookup fallo: ${system}|${code}|${versionUri} -> ${e?.response?.status || e?.message}`);
  }
}

// ===================== Debug dir =====================
const debugDir = DEBUG_DIR ? path.resolve(DEBUG_DIR) : '/tmp';
try { fs.mkdirSync(debugDir, { recursive: true }); }
catch (err) { console.error(`❌ Could not create debug directory at ${debugDir}:`, err.message); }

// ===================== OpenHIM =====================
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
registerMediator(openhimConfig, mediatorConfig, (err) => {
  if (err) { console.error('❌ Registration error:', err); process.exit(1); }
  activateHeartbeat(openhimConfig);
});

// ===================== Express =====================
const app = express();
app.use(express.json({ limit: '20mb' }));

// CORS opcional
if (CORS_ORIGIN) {
  const allowList = arr(CORS_ORIGIN);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowList.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.get('/icvp/_health', (_req, res) => res.status(200).send('OK'));

// ===================== PDQm helpers =====================
async function pdqmFetchPatientByIdentifier(identifierValue) {
  if (!identifierValue || !PDQM_FHIR_URL) return null;
  try {
    const url = `${PDQM_FHIR_URL.replace(/\/+$/, '')}/Patient`;
    const headers = { Accept: 'application/fhir+json' };
    if (PDQM_FHIR_TOKEN) headers.Authorization = `Bearer ${PDQM_FHIR_TOKEN}`;
    const resp = await axios.get(url, {
      params: { identifier: identifierValue, _count: 1 },
      headers,
      timeout: parseInt(PDQM_TIMEOUT_MS, 10) || 10000,
      httpsAgent: axios.defaults.httpsAgent
    });
    const b = resp.data;
    const pt = b?.entry?.find(e => e.resource?.resourceType === 'Patient')?.resource;
    return pt || null;
  } catch (e) {
    const statuses = new Set(arr(PDQM_FALLBACK_HTTP_STATUSES));
    const status = e.response?.status;
    const canIgnoreAuth = isTrue(PDQM_ENABLE_FALLBACK_FOR_401_403);
    const ignorable = statuses.has(String(status)) || (!canIgnoreAuth && (status === 401 || status === 403));
    console.warn('⚠️ PDQm fetch error:', status, e.response?.data || e.message, 'ignorable=', ignorable);
    return null; // No detiene el flujo
  }
}
function mergePatientDemographics(localPt, pdqmPt) {
  if (!localPt || !pdqmPt) return;
  if (pdqmPt.name) localPt.name = pdqmPt.name;
  if (pdqmPt.gender) localPt.gender = pdqmPt.gender;
  if (pdqmPt.birthDate) localPt.birthDate = pdqmPt.birthDate;
  if (pdqmPt.address) localPt.address = pdqmPt.address;
  if (Array.isArray(pdqmPt.identifier) && pdqmPt.identifier.length > 0) {
    localPt.identifier = pdqmPt.identifier;
  }
}

// ===================== Terminology client =====================
const TS_BASE_URL = (TERMINOLOGY_BASE_URL || TERMINO_SERVER_URL || '').replace(/\/+$/, '');
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
    httpsAgent: axios.defaults.httpsAgent
  });
}

// ===================== Logging helper para terminología =====================
function tsLog(level, message, data = null) {
  const debugLevel = TS_DEBUG_LEVEL.toLowerCase();
  
  if (debugLevel === 'silent') return;
  
  const shouldLog = {
    debug: ['debug'].includes(debugLevel),
    warn: ['debug', 'warn'].includes(debugLevel), 
    error: ['debug', 'warn', 'error'].includes(debugLevel)
  }[level];
  
  if (shouldLog) {
    const prefix = `🔧 TS[${level.toUpperCase()}]:`;
    if (data) {
      console[level === 'error' ? 'error' : 'log'](prefix, message, data);
    } else {
      console[level === 'error' ? 'error' : 'log'](prefix, message);
    }
  }
}

// ===================== Domain config =====================
const DOMAIN_CONFIG = {
  conditions: {
    vsExpand: CONDITIONS_VS_EXPAND_URI,
    vsValidate: CONDITIONS_VS_VALIDATE_URI,
    codeSystem: CONDITIONS_CS_URI,
    translate: {
      conceptMapUrl: CONDITIONS_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: CONDITIONS_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: CONDITIONS_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: CONDITIONS_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: CONDITIONS_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  procedures: {
    vsExpand: PROCEDURES_VS_EXPAND_URI,
    vsValidate: PROCEDURES_VS_VALIDATE_URI,
    codeSystem: PROCEDURES_CS_URI,
    translate: {
      conceptMapUrl: PROCEDURES_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: PROCEDURES_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: PROCEDURES_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: PROCEDURES_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: PROCEDURES_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  medications: {
    vsExpand: MEDICATIONS_VS_EXPAND_URI,
    vsValidate: MEDICATIONS_VS_VALIDATE_URI,
    codeSystem: MEDICATIONS_CS_URI,
    translate: {
      conceptMapUrl: MEDICATIONS_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: MEDICATIONS_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: MEDICATIONS_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: MEDICATIONS_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: MEDICATIONS_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  },
  vaccines: {
    vsExpand: VACCINES_VS_EXPAND_URI,
    vsValidate: VACCINES_VS_VALIDATE_URI,
    codeSystem: VACCINES_CS_URI,
    translate: {
      conceptMapUrl: VACCINES_TRANSLATE_CONCEPTMAP_URL || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
      sourceVS: VACCINES_TRANSLATE_SOURCE_VS || TS_TRANSLATE_DEFAULT_SOURCE_VS,
      targetVS: VACCINES_TRANSLATE_TARGET_VS || TS_TRANSLATE_DEFAULT_TARGET_VS,
      sourceSystem: VACCINES_TRANSLATE_SOURCE_SYSTEM || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
      targetSystem: VACCINES_TRANSLATE_TARGET_SYSTEM || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
    }
  }
};
const DOMAIN_NAMES = new Set(arr(TS_DOMAINS));

// ===================== Terminology Ops (funciones) =====================
async function opValidateVS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_VS_ENABLED)) return null;
  if (!domainCfg?.vsValidate) return null;
  
  try {
    const params = { url: domainCfg.vsValidate, code };
    if (system) params.system = system;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;
    
    tsLog('debug', `Validating VS: ${domainCfg.vsValidate} | ${system}|${code}`);
    
    const { data } = await ts.get('/ValueSet/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    
    if (ok.result) {
      tsLog('debug', `✅ VS validation OK: ${code} -> ${ok.display || display}`);
      return { system: system, code, display: ok.display || display, source: 'validate-vs' };
    } else {
      tsLog('debug', `❌ VS validation failed: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `VS validation error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

async function opValidateCS(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_VALIDATE_CS_ENABLED)) return null;
  const url = domainCfg?.codeSystem || system;
  if (!url || !code) return null;

  try {
    const params = { url, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    tsLog('debug', `Validating CS: ${url} | ${code}`);

    const { data } = await ts.get('/CodeSystem/$validate-code', { params });
    const ok = extractResultFromParameters(data);
    
    if (ok.result) {
      tsLog('debug', `✅ CS validation OK: ${code} -> ${ok.display || display}`);
      return { system: url, code, display: ok.display || display, source: 'validate-cs' };
    } else {
      tsLog('debug', `❌ CS validation failed: ${url}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `CS validation error: ${e.response?.status} ${e.message}`, { system: url, code });
  }
  return null;
}

async function opLookup(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_LOOKUP_ENABLED)) return null;
  if (!system || !code) return null;

  try {
    const params = { system, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    tsLog('debug', `Looking up: ${system}|${code}`);

    const { data } = await ts.get('/CodeSystem/$lookup', { params });
    const disp = extractDisplayFromLookup(data);
    
    if (disp) {
      tsLog('debug', `✅ Lookup OK: ${code} -> ${disp}`);
      return { system, code, display: disp, source: 'lookup' };
    } else {
      tsLog('debug', `❌ Lookup no display: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `Lookup error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

async function opExpand(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_EXPAND_ENABLED)) return null;
  if (!domainCfg?.vsExpand) return null;
  try {
    const params = { url: domainCfg.vsExpand };
    // Usamos display o code como filtro
    const filter = display || code;
    if (filter) params.filter = filter;
    if (TS_ACTIVE_ONLY) params.activeOnly = isTrue(TS_ACTIVE_ONLY);
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    const { data } = await ts.get('/ValueSet/$expand', { params });
    const c = data?.expansion?.contains?.[0];
    if (c?.code) {
      return { system: c.system || system, code: c.code, display: c.display || display || c.code, source: 'expand' };
    }
  } catch { /* noop */ }
  return null;
}

async function opTranslate(ts, { code, system, display }, domainCfg) {
  if (!isTrue(FEATURE_TS_TRANSLATE_ENABLED)) return null;

  const cm = domainCfg?.translate || {};
  const params = {};
  if (cm.conceptMapUrl) params.url = cm.conceptMapUrl;
  if (cm.sourceVS) params.source = cm.sourceVS;
  if (cm.targetVS) params.target = cm.targetVS;
  if (cm.sourceSystem || system) params.system = cm.sourceSystem || system;
  if (cm.targetSystem) params.targetsystem = cm.targetSystem;
  if (code) params.code = code;
  if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

  const hasConfig = params.url || params.source || params.target || params.targetsystem;
  if (!hasConfig) {
    tsLog('debug', 'Translate skipped: no ConceptMap config', { system, code });
    return null;
  }

  try {
    tsLog('debug', `Translating: ${system}|${code} -> ${params.targetsystem}`);
    const { data } = await ts.get('/ConceptMap/$translate', { params });
    const match = extractMatchFromTranslate(data);
    if (match?.system && match?.code) {
      tsLog('debug', `✅ Translate OK: ${code} -> ${match.code}`);
      return { system: match.system, code: match.code, display: match.display || display || code, source: 'translate' };
    } else {
      tsLog('debug', `❌ Translate no match: ${system}|${code}`);
    }
  } catch (e) {
    tsLog('warn', `Translate error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

// ===================== TerminologyOp Response Parsers =====================
function extractResultFromParameters(data) {
  // Parameters.parameter[name=result|message|display]
  const out = { result: false, display: undefined };
  if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
    for (const p of data.parameter) {
      if (p.name === 'result') out.result = (p.valueBoolean === true || p.valueString === 'true');
      if (p.name === 'display' && p.valueString) out.display = p.valueString;
    }
  } else if (data?.resourceType === 'OperationOutcome') {
    // heurística
    out.result = Array.isArray(data.issue) && data.issue.some(i => (i.severity === 'information' || i.severity === 'success'));
  }
  return out;
}
function extractDisplayFromLookup(data) {
  if (data?.resourceType !== 'Parameters' || !Array.isArray(data.parameter)) return undefined;
  const p = data.parameter.find(x => x.name === 'display');
  return p?.valueString;
}

function extractMatchFromTranslate(data) {
  if (data?.resourceType !== 'Parameters') return null;
  const matchParam = data.parameter?.find(p => p.name === 'match');
  if (!matchParam?.part) return null;

  let equivalence, system, code, display;
  for (const part of matchParam.part) {
    if (part.name === 'equivalence') equivalence = part.valueCode;
    if (part.name === 'concept' && part.valueCoding) {
      system = part.valueCoding.system;
      code = part.valueCoding.code;
      display = part.valueCoding.display;
    }
  }

  if (equivalence && system && code) {
    return { system, code, display };
  }
  return null;
}

// ===================== Terminology Pipeline =====================
const CS_ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const CS_SCT = 'http://snomed.info/sct';

function shouldLookupTS(system) {
  if (!isTrue(FEATURE_TS_ENABLED)) return false;
  if (system === CS_ABSENT) return false;
  if (system === CS_SCT && process.env.TS_HAS_SNOMED !== 'true') return false;
  return true;
}

function sortCodingsPreferred(codings) {
  const pref = [CS_SCT]; // primero SNOMED
  return [...codings].sort((a, b) => {
    const aIdx = pref.indexOf(a.system);
    const bIdx = pref.indexOf(b.system);
    if (aIdx !== -1 && bIdx === -1) return -1;
    if (aIdx === -1 && bIdx !== -1) return 1;
    return 0;
  });
}

function pickDomainCoding(cc, domainCfg) {
  if (!cc?.coding) return null;
  const targetSys = domainCfg?.codeSystem || 'http://snomed.info/sct';
  return cc.coding.find(c => c.system === targetSys && c.code) || cc.coding[0] || null;
}

function buildPipeline(domain, ts, base, domainCfg) {
  // Secuencia: validateVS → validateCS → lookup → translate
  return [
    () => opLookup(ts, base, domainCfg),
    () => opValidateVS(ts, base, domainCfg),
    () => opValidateCS(ts, base, domainCfg),
    () => opTranslate(ts, base, domainCfg),
  ];
}

async function normalizeCC(ts, cc, domainCfg, domain) {
  if (!cc?.coding || !Array.isArray(cc.coding) || cc.coding.length === 0) return;

  const target = pickDomainCoding(cc, domainCfg);
  if (!target) return;

  const base = {
    system: target.system,
    code: target.code,
    display: target.display || cc.text
  };


  // Skip TS lookup for absent/unknown codes and SNOMED when not available
  if (!shouldLookupTS(base.system)) return;

  const steps = buildPipeline(domain, ts, base, domainCfg);

  for (const step of steps) {
    try {
      const result = await step();
      if (result?.system && result?.code) {
        target.system = result.system;
        target.code = result.code;
        target.display = result.display || target.display || cc.text;
        return; // Usa el primer resultado exitoso
      }
    } catch (error) {
      continue; // Continúa con el siguiente paso
    }
  }
}

function* iterateCodeableConcepts(resource) {
  if (!resource || typeof resource !== 'object') return;

  const typeToFields = {
    'Condition': ['code'],
    'Procedure': ['code'],
    'MedicationStatement': ['medicationCodeableConcept'],
    'MedicationRequest': ['medicationCodeableConcept'],
    'Immunization': ['vaccineCode'],
    'AllergyIntolerance': ['code'],
    'Observation': ['code'],
  };

  const fields = typeToFields[resource.resourceType] || [];
  for (const field of fields) {
    if (resource[field]) {
      yield { path: field, cc: resource[field] };
    }
  }
}

async function normalizeTerminologyInBundle(bundle) {
  if (!isTrue(FEATURE_TS_ENABLED)) return;
  const ts = buildTsClient();
  if (!ts || !bundle?.entry?.length) return;

  // --- SOLO CONSULTA: ejecutar $lookup para cada código SNOMED sin usar datos ---
  // Se puede habilitar/forzar con LOOKUP_SNOMED_ONLY=true
  if (LOOKUP_SNOMED_ONLY) {
    const uniq = new Set(); // system|code|version
    const entries = bundle?.entry || [];
    const versionDefault = process.env.SNOMED_VERSION_URI
      || 'http://snomed.info/sct/900000000000207008/version/20240331';
    for (const ent of entries) {
      const res = ent.resource;
      if (!res) continue;
      const codables = [
        res.code, res.medicationCodeableConcept, res.category, res.clinicalStatus
      ].filter(Boolean);
      for (const cc of codables) {
        const codings = cc.coding || [];
        for (const c of codings) {
          if (c?.system === SNOMED_SYSTEM && c?.code) {
            uniq.add(`${c.system}|${c.code}|${versionDefault}`);
          }
        }
      }
    }
    await Promise.all(
      [...uniq].map(k => {
        const [system, code, versionUri] = k.split('|');
        return fireAndForgetSnomedLookup(ts, system, code, versionUri);
      })
    );
  }

  console.log('🔍 Iniciando normalización terminológica con enfoque SNOMED...');

  for (const entry of bundle.entry) {
    const res = entry.resource;
    if (!res) continue;

    // 🚫 Desactivar toda normalización terminológica para vacunas
    if (res.resourceType === 'Immunization' && (FEATURE_TS_VACCINES_ENABLED ?? 'true').toLowerCase() === 'false') {
      tsLog('debug', 'TS[SKIP]: Vaccines normalization disabled by FEATURE_TS_VACCINES_ENABLED=false');
      continue; // salir sin hacer lookup/translate
    }

    // Determinar dominio
    const domain = resourceToDomain(res);
    const domainCfg = DOMAIN_CONFIG[domain] || DOMAIN_CONFIG[TS_DEFAULT_DOMAIN] || {};
    if (!DOMAIN_NAMES.has(domain)) {
      // Dominio no listado en TS_DOMAINS → igualmente intenta con default
      // (o puedes simplemente continue)
    }

    // Normalizar todas las CC relevantes del recurso
    for (const { cc } of iterateCodeableConcepts(res)) {
      try { await normalizeCC(ts, cc, domainCfg, domain); }
      catch (e) { console.warn(`⚠️ TS normalize error (${domain}):`, e.message); }
    }
  }

  console.log('✅ Normalización terminológica completada');
}

// ===================== Mapeo recurso → dominio =====================
function resourceToDomain(resource) {
  switch (resource.resourceType) {
    case 'Condition': return 'conditions';
    case 'Procedure': return 'procedures';
    case 'MedicationRequest':
    case 'MedicationStatement': return 'medications';
    case 'Immunization': return 'vaccines';
    case 'AllergyIntolerance': return 'conditions'; // si más adelante agregas "allergies", cámbialo aquí
    default: return TS_DEFAULT_DOMAIN || 'conditions';
  }
}

// ===================== Helpers para PDQm =====================

function pickIdentifiersOrderedForPdqm(identifiers) {
    if (!Array.isArray(identifiers) || identifiers.length === 0) return [];

    const norm = (s) => String(s || '').trim();
    // IMPORTANTE: para "Pasaporte" por texto NO exigimos formato ni system
    const anyPassportByText = (id) =>
        /passport|pasaporte/i.test(norm(id?.type?.text)) && !!norm(id?.value);

    // Mantengo un detector opcional de "valor con pinta de pasaporte" para el resto de casos
    const looksLikePassportValue = (v) => {
        if (!v) return false;
        if (/\*/.test(v)) return false;
        if (/^RUN\*/i.test(v)) return false;
        return /^[A-Z]{2}[A-Z0-9]{5,}$/i.test(v);
    };
    const preferCL = (arr) =>
        arr.sort((a, b) => (/^CL/i.test(norm(b.value)) ? 1 : 0) - (/^CL/i.test(norm(a.value)) ? 1 : 0));

    const passportTypeCode = (process.env.PDQM_IDENTIFIER_TYPE_CODE_PASSPORT || 'PPN').trim();
    const passportTypeText = (process.env.PDQM_IDENTIFIER_TYPE_TEXT_PASSPORT || 'Pasaporte').toLowerCase();
    const nationalTypeText = (process.env.PDQM_IDENTIFIER_TYPE_TEXT_NATIONAL  || 'RUN').toLowerCase();

    const isPassportId = (id) => {
        const codings = (id.type?.coding || []);
        const codeHit = codings.some(c => norm(c.code).toUpperCase() === passportTypeCode.toUpperCase());
        // soporte explícito al code que nos compartiste para "Pasaporte"
        const altCodeHit = codings.some(c => norm(c.code) === 'a2551e57-6028-428b-be3c-21816c252e06');
        const textHit = norm(id.type?.text).toLowerCase().includes(passportTypeText) ||
            /passport|pasaporte/i.test(norm(id.type?.text));
        return (codeHit || altCodeHit || textHit) && !!norm(id.value);
    };
    const isNationalId = (id) => {
        const txt = norm(id.type?.text);
        const code = norm(id.type?.coding?.[0]?.code);
        const val = norm(id.value);
        if (/^RUN\*/i.test(val)) return true;                 // RUN*...
        if (/run|nacional|national/i.test(txt)) return true;  // por texto
        if (code && /RUN/i.test(code)) return true;           // por code si existiera
        return false;
    };

    // 1) Pasaporte por TEXTO (sin exigir system/format)
    const passportByText = preferCL(
        identifiers.filter(anyPassportByText)
    ).map(i => norm(i.value));

    // 2) Pasaporte formal (por coding o texto, pero además con pinta de pasaporte)
    const passportFormal = preferCL(
        identifiers.filter(isPassportId).filter(i => looksLikePassportValue(i.value))
    ).map(i => norm(i.value));

    // 3) Pasaporte "por forma" (value parece pasaporte) excluyendo RUN
    const passportShape  = preferCL(
        identifiers.filter(i => !isNationalId(i) && looksLikePassportValue(i.value))
    ).map(i => norm(i.value));
    // 4) Nacional (RUN) como fallback
    const nationals      = identifiers.filter(isNationalId).map(i => norm(i.value));
    // 5) Último recurso: cualquier value sin * ni RUN*
    const lastResort     = identifiers
        .filter(i => !!norm(i.value) && !/\*/.test(norm(i.value)) && !/^RUN\*/i.test(norm(i.value)))
        .map(i => norm(i.value));

    // Unificar preservando orden y sin duplicados
    const seen = new Set();
    const ordered = [...passportByText, ...passportFormal, ...passportShape, ...nationals, ...lastResort]
        .filter(v => { if (seen.has(v)) return false; seen.add(v); return true; });
    return ordered;
}

function generateFallbackBundle(identifierValue) {
    const fallbackBundle = {
        resourceType: 'Bundle',
        id: `pdqm-fallback-${Date.now()}`,
        type: 'searchset',
        total: 1,
        entry: [{
            fullUrl: `Patient/pdqm-fallback-${identifierValue}`,
            resource: {
                resourceType: 'Patient',
                id: `pdqm-fallback-${identifierValue}`,
                identifier: [{
                    system: PDQM_DEFAULT_IDENTIFIER_SYSTEM || toUrnOid('1.2.3.4.5'),
                    value: identifierValue
                }],
                name: [{
                    text: `Paciente PDQm Fallback ${identifierValue}`
                }],
                meta: {
                    tag: [{
                        system: 'http://example.org/tag',
                        code: 'pdqm-fallback',
                        display: 'PDQm Fallback Bundle'
                    }]
                }
            }
        }]
    };

    return fallbackBundle;
}

// ===================== PDQm Utils =====================
// ===================== URL Encoding Helper =====================
function robustUrlEncode(value) {
    if (!value) return '';

    // Primero, codificación URL estándar
    let encoded = encodeURIComponent(value);

    // Luego, codificaciones adicionales para caracteres que pueden causar problemas en queries
    encoded = encoded.replace(/\*/g, '%2A');  // Asterisco
    encoded = encoded.replace(/'/g, '%27');   // Comilla simple
    encoded = encoded.replace(/"/g, '%22');   // Comilla doble
    encoded = encoded.replace(/\(/g, '%28');  // Paréntesis abierto
    encoded = encoded.replace(/\)/g, '%29');  // Paréntesis cerrado

    return encoded;
}



function asFhirBase(url) {
    const u = (url || '').replace(/\/+$/, '');
    return /\/fhir$/i.test(u) ? u : `${u}/fhir`;
}

function joinUrl(base, path) {
    const b = (base || '').replace(/\/+$/, '');
    const p = (path || '').replace(/^\/+/, '');
    return `${b}/${p}`;
}

// ===================== PDQm =====================
async function pdqmFetchBundleByIdentifier(identifierValue) {
    console.log('🔍 PDQm fetch for identifier:', identifierValue, 'using PDQM_FHIR_URL:', PDQM_FHIR_URL);
    if (!PDQM_FHIR_URL || !identifierValue) return null;
    console.log('---')

    const maxAttempts = 3;
    let currentAttempt = 0;

    while (currentAttempt < maxAttempts) {
        currentAttempt++;
        console.log(`PDQm attempt ${currentAttempt}/${maxAttempts} for identifier: ${identifierValue}`);

        try {
            // Construir configuración de solicitud
            const config = {
                timeout: parseInt(PDQM_TIMEOUT_MS, 10),
                httpsAgent: axios.defaults.httpsAgent,
                validateStatus: (status) => {
                    // Considerar como válidos los estados esperados
                    return status < 500 && status !== 429; // No reintentar en errores de servidor o throttling
                }
            };

            if (PDQM_FHIR_TOKEN) {
                config.headers = { 'Authorization': `Bearer ${PDQM_FHIR_TOKEN}` };
            }

            // Intentar con el parámetro identifier por defecto
            const base = asFhirBase(PDQM_FHIR_URL);
            let url = joinUrl(base, '/Patient') + `?identifier=${robustUrlEncode(identifierValue)}`;
            console.log(`PDQm GET: ${url}`);

            let response = await axios.get(url, config);

            // Si la respuesta es exitosa y contiene datos, retornar
            if (response.status === 200 && response.data?.resourceType === 'Bundle') {
                console.log(`✅ PDQm response: ${response.data.total || 0} patients found`);
                return response.data;
            }

            // Si no hay resultados y hay parámetros de fallback configurados, intentar con ellos
            if (response.status === 200 && response.data?.total === 0 && PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES) {
                const fallbackParams = arr(PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES);

                for (const param of fallbackParams) {
                    url = joinUrl(base, '/Patient') + `?${param}=${robustUrlEncode(identifierValue)}`;
                    console.log(`PDQm fallback GET: ${url}`);

                    response = await axios.get(url, config);

                    if (response.status === 200 && response.data?.resourceType === 'Bundle' && response.data.total > 0) {
                        console.log(`✅ PDQm fallback response: ${response.data.total} patients found with param ${param}`);
                        return response.data;
                    }
                }
            }

            // Manejar códigos de estado específicos
            if (response.status === 401 || response.status === 403) {
                if (isTrue(PDQM_ENABLE_FALLBACK_FOR_401_403)) {
                    console.warn(`PDQm auth error (${response.status}), generating fallback bundle`);
                    return generateFallbackBundle(identifierValue);
                } else {
                    console.error(`PDQm auth error (${response.status}), no fallback enabled`);
                    return null;
                }
            }

            // Verificar si debemos reintentar basado en el estado HTTP
            const fallbackStatuses = arr(PDQM_FALLBACK_HTTP_STATUSES || '404,400');
            if (fallbackStatuses.includes(response.status.toString())) {
                console.warn(`PDQm response status ${response.status}, will retry or fallback`);

                if (currentAttempt >= maxAttempts) {
                    console.warn(`Max attempts reached, generating fallback bundle`);
                    return generateFallbackBundle(identifierValue);
                }

                // Esperar antes del siguiente intento
                await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
                continue;
            }

            // Si llegamos aquí, retornar los datos obtenidos (aunque sean vacíos)
            return response.data;

        } catch (error) {
            console.error(`PDQm error (attempt ${currentAttempt}):`, error.message);

            // Decidir si reintentar o generar fallback
            if (currentAttempt >= maxAttempts) {
                console.warn('Max attempts reached, generating fallback bundle');
                return generateFallbackBundle(identifierValue);
            }

            // Esperar antes del siguiente intento
            await new Promise(resolve => setTimeout(resolve, 1000 * currentAttempt));
        }
    }

    return null;
}

function isPdqmFallbackBundle(bundle) {
    return bundle?.entry?.[0]?.resource?.meta?.tag?.some(tag =>
        tag.code === 'pdqm-fallback'
    ) === true;
}

// ===================== Helpers nuevos =====================

function stripNarrativeLinkExtensions(resource) {
    if (!resource || !Array.isArray(resource.extension)) return;
    // En perfiles IPS varias resources usan slicing cerrado sobre extension;
    // narrativeLink NO está permitido ahí => hay que removerla.
    resource.extension = resource.extension.filter(
        (e) => e?.url !== 'http://hl7.org/fhir/StructureDefinition/narrativeLink'
    );
    if (resource.extension.length === 0) {
        delete resource.extension;
    }
}


function sanitizeAllergyIntolerance(ai) {
    if (!ai || ai.resourceType !== 'AllergyIntolerance') return;
    // code: dejar SNOMED primero y eliminar codings sin system
    if (Array.isArray(ai.code?.coding)) {
        ai.code.coding = ai.code.coding
            // fuera codings sin system y los locales OpenMRS
            .filter(c => !!c?.system && c.system !== 'http://openmrs.org/concepts')
            // SNOMED primero
            .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
    }
    // reaction[].manifestation: idem
    (ai.reaction || []).forEach(r => {
        if (Array.isArray(r.manifestation)) {
            r.manifestation.forEach(m => {
                if (Array.isArray(m.coding)) {
                    m.coding = m.coding
                        .filter(c => !!c?.system)
                        .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
                }
            });
        }
        // NEW: reaction.substance.coding → también limpiar y ordenar
        if (r.substance?.coding && Array.isArray(r.substance.coding)) {
            r.substance.coding = r.substance.coding
                .filter(c => !!c?.system && c.system !== 'http://openmrs.org/concepts')
                .sort((a,b) => (a.system === 'http://snomed.info/sct' ? -1 : 1));
        }
    });
}

// --- NUEVO: Sanitizar Medication (quitar ext OMRS y dejar solo SNOMED) ---
function sanitizeMedicationResource(med) {
    if (!med || med.resourceType !== 'Medication') return;
    // 1) quitar extensiones OMRS
    if (Array.isArray(med.extension)) {
        med.extension = med.extension.filter(e => !String(e.url).startsWith('http://fhir.openmrs.org/ext/medicine'));
        if (med.extension.length === 0) delete med.extension;
    }
    // 2) code.coding → solo SNOMED, y sin codings sin system
    if (med.code?.coding) {
        med.code.coding = med.code.coding
            .filter(c => c?.system && c.system === 'http://snomed.info/sct');
        if (med.code.coding.length === 0) delete med.code.coding;
    }
    // 3) form.coding → solo SNOMED; si queda vacío, elimina form
    if (med.form?.coding) {
        med.form.coding = med.form.coding
            .filter(c => c?.system && c.system === 'http://snomed.info/sct');
        if (med.form.coding.length === 0) delete med.form.coding;
    }
    if (med.form && !med.form.coding && !med.form.text) delete med.form;
    // 4) asegurar textos básicos
    if (med.code && !med.code.text) med.code.text = 'Medication';
}

// --- OPCIONAL: Sanitizar Practitioner.identifier.system no estándar (OMRS) ---
function sanitizePractitionerIdentifiers(prac) {
    if (!prac || prac.resourceType !== 'Practitioner') return;
    if (!Array.isArray(prac.identifier)) return;
    prac.identifier.forEach(id => {
        if (typeof id?.system === 'string' &&
            id.system.startsWith('http://fhir.openmrs.org/ext/provider/identifier')) {
            // quita el system no resoluble; deja value/type para que siga siendo usable
            delete id.system;
        }
    });
    // limpia identifiers vacíos
    prac.identifier = prac.identifier.filter(id => id.value || id.type || id.system);
    if (prac.identifier.length === 0) delete prac.identifier;
}
function fixPatientIdentifiers(bundle) {
    const patient = (bundle?.entry || [])
        .map(e => e.resource)
        .find(r => r?.resourceType === 'Patient');
    if (!patient) return;

    patient.identifier = Array.isArray(patient.identifier) ? patient.identifier : [];

    // Systems normalizados (LAC)
    const defaultNatOid = toUrnOid(DEFAULT_NAT_OID || '2.16.152'); // siempre URN OID con "."
    const defaultPpnOid = toUrnOid(DEFAULT_PPN_OID || '2.16.840.1.113883.4.330.152');

    // Filtrar solo pasaportes
    // Normalizar solo los identificadores que sean pasaporte, conservando el resto sin borrar nada
    for (const id of patient.identifier) {
        const txt = (id?.type?.text || '').toLowerCase();
        const isPassportByText = /pasaporte|passport/.test(txt);
        const isPassportByCode = (id?.type?.coding || []).some(c =>
            String(c?.code || '').toUpperCase() === 'PPN' ||
            String(c?.code || '') === 'a2551e57-6028-428b-be3c-21816c252e06'
        );
        
        // Si es pasaporte, lo normaliza. Si no lo es, lo ignora y lo deja intacto.
        if (isPassportByText || isPassportByCode) {
            id.system = id.system || defaultPpnOid;
            id.use = 'official';
            id.type = id.type || {};
            id.type.coding = [{
                system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                code: 'PPN'
            }];
            if (id.type.text) delete id.type.text;
        }
    }

    /*// Asegurar que exista al menos un national id si no vino (slice requerido)
    const hasNational = patient.identifier.some(id =>
        String(id.system||'') === defaultNatOid ||
        (id.type?.coding||[]).some(c => c.system === 'http://lacpass.racsel.org/CodeSystem/national-identifier-types' && c.code === 'RUN')
    );
    if (!hasNational) {
        patient.identifier.unshift({
            use: 'usual',
            system: defaultNatOid,                     // urn:oid.2.16.152
            type: { coding: [{ system: 'http://lacpass.racsel.org/CodeSystem/national-identifier-types', code: 'RUN' }] },
            value: patient.identifier?.[0]?.value || `RUN*${patient.id || 'UNKNOWN'}`
        });
    }*/
}
/**
 * Asegura que una propiedad sea un array
 */
function ensureArray(obj, property) {
    if (!obj[property]) {
        obj[property] = [];
    } else if (!Array.isArray(obj[property])) {
        obj[property] = [obj[property]];
    }
    return obj[property];
}
/**
 * Agrega un perfil a un recurso si no existe
 */
function addProfile(resource, profileUrl) {
    if (!resource || !profileUrl) return;

    if (!resource.meta) resource.meta = {};
    ensureArray(resource.meta, 'profile');

    if (!resource.meta.profile.includes(profileUrl)) {
        resource.meta.profile.push(profileUrl);
    }
}


function ensureLacPatientProfile(patient) {
    addProfile(patient, LAC_PROFILES.PATIENT);
}

function ensureIpsPatientProfile(patient) {
    addProfile(patient, IPS_PROFILES.PATIENT);
}

// === Helpers URN OID (admiten ":" y "."; emiten con separador configurable) ===
function isUrnOid(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    // Aceptar 'urn:oid:1.2.3' o 'urn:oid.1.2.3'
    return /^urn:oid[.:]\d+(?:\.\d+)+$/.test(v);
}
function toUrnOid(value) {
    if (!value) return null;
    const v = String(value).trim();
    // Si ya viene como URN con ":" o ".", normalizar al separador elegido
    if (/^urn:oid[.:]\d+(?:\.\d+)+$/.test(v)) {
        // Reemplaza el separador actual por el configurado
        return v.replace(/^urn:oid[.:]/, `urn:oid${OID_URN_SEPARATOR}`);
    }
    // Si viene como OID "crudo" (solo dígitos y puntos), formatear
    const m = v.match(/(\d+(?:\.\d+)+)/);
    return m ? `urn:oid${OID_URN_SEPARATOR}${m[1]}` : null;
}

function ensureLacBundleProfile(bundle) {
    addProfile(bundle, LAC_PROFILES.BUNDLE);
}

function ensureLacCompositionProfile(comp) {
    addProfile(comp, LAC_PROFILES.COMPOSITION);
}
function ensureCompositionSubject(comp, patientEntry) {
    if (!comp || !patientEntry) return;
    const patientId = patientEntry.resource?.id
        || (typeof patientEntry.fullUrl === 'string'
            ? patientEntry.fullUrl.replace(/^urn:uuid:/, '').replace(/^Patient\//, '')
            : null);

    if (patientId) {
        const ref = buildRef('Patient', patientId);
        if (ref) comp.subject = { reference: ref }; // con FULLURL_MODE_DOCUMENT='urn' retorna 'urn:uuid:<id>'
        return;
    }

    const fallbackRef = patientEntry.fullUrl || (patientEntry.resource?.id ? `Patient/${patientEntry.resource.id}` : null);
    if (fallbackRef) comp.subject = { reference: fallbackRef };
}
// ---- Helpers to classify Conditions for IPS sections ----
function isAbsentProblemCondition(cond) {
    const codings = (cond?.code?.coding) || [];
    return codings.some(c => c.system === 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips' &&
        (c.code === 'no-problem-info' || /no information about problems/i.test(c.display || '')));
}

function clinicalStatusCode(cond) {
    return cond?.clinicalStatus?.coding?.[0]?.code || null;
}

function hasAbatement(cond) {
    return !!(cond?.abatementDateTime || cond?.abatementPeriod || cond?.abatementAge || cond?.abatementRange || cond?.abatementString);
}

function isActiveProblem(cond) {
    return ['active','recurrence','relapse'].includes(clinicalStatusCode(cond));
}
function isPastIllness(cond) {
    const cs = clinicalStatusCode(cond);
    return ['inactive','remission','resolved'].includes(cs) || hasAbatement(cond);
}

function ensureIpsProfile(resource) {
    if (!resource?.resourceType) return;

    const profileMap = {
        'AllergyIntolerance': IPS_PROFILES.ALLERGY_INTOLERANCE,
        'MedicationStatement': IPS_PROFILES.MEDICATION_STATEMENT,
        'MedicationRequest': IPS_PROFILES.MEDICATION_REQUEST,
        'Medication': IPS_PROFILES.MEDICATION,
        'Condition': IPS_PROFILES.CONDITION,
        'Procedure': IPS_PROFILES.PROCEDURE,
        'Immunization': IPS_PROFILES.IMMUNIZATION,
        'Observation': IPS_PROFILES.OBSERVATION
    };

    const profile = profileMap[resource.resourceType];
    if (profile) {
        addProfile(resource, profile);
    }
}


function toIso2Country(input) {
    if (!input) return null;
    const raw = String(input).trim();
    // Ya viene ISO-2
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    // Viene ISO-3
    if (/^[A-Za-z]{3}$/.test(raw)) return ISO3_TO_ISO2[raw.toUpperCase()] ?? null;
    // Viene por nombre
    const key = normKey(raw);
    return COUNTRY_MAP.get(key) ?? null;
}



// Asegura que exista al menos una entry válida para el slice requerido de la sección:
// - loincCode: código LOINC de la sección (p.ej. 48765-2 Alergias, 11450-4 Problemas, 11348-0 Antecedentes)
// - allowedTypes: tipos de recurso aceptados por el slice (p.ej. ['AllergyIntolerance'])
function ensureRequiredSectionEntry(summaryBundle, comp, loincCode, allowedTypes) {
    if (!comp?.section) return;
    const sec = comp.section.find(s => s.code?.coding?.some(c => c.system === 'http://loinc.org' && c.code === loincCode));
    if (!sec) return;

    // Vamos a reconstruir completamente las entradas de la sección cuando sea Condition
    // para cumplir con sectionProblems (11450-4) y sectionPastIllnessHx (11348-0).
    if (allowedTypes.includes('Condition')) {
        const isPastSection = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION; // 11348-0
        const isProblemsSection = loincCode === LOINC_CODES.PROBLEMS_SECTION;  // 11450-4

        // Todas las Conditions en el bundle (y que no sean "absent/unknown")
        const allConds = (summaryBundle.entry || [])
            .filter(x => x.resource?.resourceType === 'Condition' && !isAbsentProblemCondition(x.resource));

        // Clasificación (usa helpers existentes)
        const actives = allConds.filter(x => isActiveProblem(x.resource));
        const pasts   = allConds.filter(x => isPastIllness(x.resource));

        // Conjunto objetivo según la sección
        let target = [];
        if (isProblemsSection) target = actives;
        if (isPastSection)     target = pasts;

        // Si hay target, lo aplicamos completo; si no, dejamos que el fallback genérico haga placeholder
        if (target.length > 0) {
            // Ensamblar referencias sin duplicados
            const uniq = new Set();
            sec.entry = [];
            for (const candidate of target) {
                ensureIpsProfile(candidate.resource);
                if (!uniq.has(candidate.fullUrl)) {
                    uniq.add(candidate.fullUrl);
                    sec.entry.push({ reference: candidate.fullUrl });
                }
            }
            // Salimos porque ya poblamos esta sección correctamente
            return;
        }
        // Si no había ninguna Condition para esta sección, caeremos al fallback más abajo (placeholder)
    }



    // Si no hay entries válidas, buscar candidatos y enlazarlos
    const candidates = (summaryBundle.entry || []).filter(x => allowedTypes.includes(x.resource?.resourceType));

    // NOTA: ya manejamos Condition arriba. De aquí en adelante, secciones no-Condition.

    // Generic fallback (non-Condition sections): add ALL candidates (e.g., Immunization)
    if (candidates.length > 0) {
        sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
        const seen = new Set(sec.entry.map(e => e.reference));
        for (const candidate of candidates) {
            ensureIpsProfile(candidate.resource);
            let ref = candidate.fullUrl;
            if (!ref && candidate.resource?.id) {
                ref = `${candidate.resource.resourceType}/${candidate.resource.id}`;
            }
            if (!ref || seen.has(ref)) continue;
            sec.entry.push({ reference: ref });
            seen.add(ref);
        }
        // dedupe en caso de referencias repetidas en entradas manuales previas
        sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
        return;
    }

    console.log(`🔍 Ensuring entries for section LOINC ${loincCode} with allowed:`, allowedTypes);
    console.log('---',sec.entry);

    // Si tampoco hay candidatos: inyectar placeholder IPS "no known …"
    const patientEntry = (summaryBundle.entry || []).find(e => e.resource?.resourceType === 'Patient');
    const patRef = patientEntry?.fullUrl || (patientEntry?.resource?.id ? `Patient/${patientEntry.resource.id}` : null);
    const nowIso = new Date().toISOString();
    let placeholder = null;

    if (allowedTypes.includes('AllergyIntolerance')) {
        placeholder = {
            fullUrl: 'urn:uuid:allergy-none',
            resource: {
                resourceType: 'AllergyIntolerance',
                meta: { profile: [IPS_PROFILES.ALLERGY_INTOLERANCE] },
                clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
                verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'unconfirmed' }] },
                code: {
                    coding: [
                        { system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-allergies', display: 'No known allergies' },
                        { system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy (situation)' },
                        { system: CS_DATA_ABSENT_REASON, code: 'unknown' }
                    ],
                    text: 'No known allergies'
                },
                patient: patRef ? { reference: patRef } : undefined
            }
        };
    } else if (allowedTypes.includes('MedicationStatement')) {
        placeholder = {
            fullUrl: 'urn:uuid:meds-none',
            resource: {
                resourceType: 'MedicationStatement',
                meta: { profile: [IPS_PROFILES.MEDICATION_STATEMENT] },
                status: 'active',
                medicationCodeableConcept: {
                    coding: [
                        { system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-medications', display: 'No known medications' },
                        { system: CS_DATA_ABSENT_REASON, code: 'unknown' }
                    ],
                    text: 'No known medications'
                },
                subject: patRef ? { reference: patRef } : undefined,
                effectiveDateTime: nowIso
            }
        };
    } else if (allowedTypes.includes('Immunization')) {
        // Placeholder de sección solo si realmente quieres declarar "sin info de vacunas"
        // placeholder = {
        //     fullUrl: 'urn:uuid:immu-none',
        //     resource: {
        //         resourceType: 'Immunization',
        //         meta: { profile: [IPS_PROFILES.IMMUNIZATION] },
        //         status: 'not-done',
        //         vaccineCode: {
        //             coding: [{
        //                 system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips',
        //                 code: 'no-immunization-info',
        //                 display: 'No information about immunizations'
        //             }]
        //         },
        //         subject: patRef ? { reference: patRef } : undefined,
        //         occurrenceDateTime: nowIso
        //     }
        // };
    } else if (allowedTypes.includes('Condition')) {
        const isPast = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION;
        placeholder = {
            fullUrl: isPast ? 'urn:uuid:pasthx-none' : 'urn:uuid:problem-none',
            resource: {
                resourceType: 'Condition',
                meta: { profile: [IPS_PROFILES.CONDITION] },
                category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
                code: {
                    coding: [
                        { system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-problems', display: 'No known problems' },
                        { system: CS_DATA_ABSENT_REASON, code: 'unknown' }
                    ],
                    text: isPast ? 'No known past illnesses' : 'No known problems'
                },
                subject: patRef ? { reference: patRef } : undefined
            }
        };
    }

    if (placeholder) {
        summaryBundle.entry = Array.isArray(summaryBundle.entry) ? summaryBundle.entry : [];
        summaryBundle.entry.push(placeholder);
        sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
        sec.entry.push({ reference: placeholder.fullUrl });
        // dedupe entries
        sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
    }
    console.log('--- After adding placeholder:',sec.entry);
}


function fixPatientCountry(bundle) {
    const patient = (bundle.entry ?? [])
        .map(e => e.resource)
        .find(r => r?.resourceType === "Patient");
    if (!patient) return;

    (patient.address ?? []).forEach(addr => {
        if (!addr.country) return;
        const iso2 = toIso2Country(addr.country);
        if (iso2) addr.country = iso2; // e.g., "CL"
    });
}

// ===== Helpers de modos de URL =====
// Normalizamos una vez y reutilizamos SIEMPRE
const ABS_BASE = asAbsoluteBase(ABSOLUTE_FULLURL_BASE);

function makeAbsolute(resourceType, id) {
    if (!ABS_BASE) return makeUrn(id);
    return `${ABS_BASE}/${resourceType}/${id}`;
}

function makeRelative(resourceType, id) {
    return `${resourceType}/${id}`;
}

function makeUrn(id) {
    return `urn:uuid:${id}`;
}

// --- buildRef (sobrecargado) ---
function buildRef(modeOrType, resourceTypeOrId, maybeId) {
    let mode = modeOrType;
    let resourceType = resourceTypeOrId;
    let id = maybeId;

    // Permite firma abreviada: buildRef(resourceType, id) -> usa FULLURL_MODE_DOCUMENT
    if (typeof maybeId === 'undefined') {
        id = resourceTypeOrId;
        resourceType = modeOrType;
        mode = FULLURL_MODE_DOCUMENT;
    }

    const cleanType = String(resourceType || '').trim();
    let cleanId = String(id || '')
        .replace(/^urn:uuid:/, '')
        .replace(/^([A-Za-z]+)\//, '')
        .trim();

    if (!cleanType || !cleanId) return null;

    switch ((mode || '').toLowerCase()) {
        case 'absolute':
            return makeAbsolute(cleanType, cleanId);
        case 'relative':
            return makeRelative(cleanType, cleanId);
        default:
            return makeUrn(cleanId);
    }
}

function fromUrlMap(urlMap, key) {
    if (!urlMap || !key) return undefined;
    if (urlMap instanceof Map) return urlMap.get(key);
    return urlMap[key];
}

// --- reescritura recursiva de referencias + Attachment.url ---
function updateReferencesInObject(obj, urlMap) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        obj.forEach(item => updateReferencesInObject(item, urlMap));
        return;
    }

    if (typeof obj.reference === 'string') {
        const candidate = obj.reference.trim();
        const replacement = fromUrlMap(urlMap, candidate);
        if (replacement) obj.reference = replacement;
    }

    const looksLikeAttachment =
        Object.prototype.hasOwnProperty.call(obj, 'contentType') &&
        (Object.prototype.hasOwnProperty.call(obj, 'data') ||
         Object.prototype.hasOwnProperty.call(obj, 'url') ||
         Object.prototype.hasOwnProperty.call(obj, 'hash'));
    if (looksLikeAttachment && typeof obj.url === 'string') {
        const candidate = obj.url.trim();
        const replacement = fromUrlMap(urlMap, candidate);
        if (replacement) obj.url = replacement;
    }

    for (const key of Object.keys(obj)) updateReferencesInObject(obj[key], urlMap);
}

function checkAndFixReferences(bundle) {
    if (!bundle?.entry?.length) return;
    const indexByKey = {};

    for (const entry of bundle.entry) {
        const resource = entry?.resource;
        if (!resource?.resourceType) continue;
        const resourceType = resource.resourceType;
        let id = resource.id || '';
        if (entry.fullUrl?.startsWith('urn:uuid:')) {
            id = entry.fullUrl.replace(/^urn:uuid:/, '') || id;
        }
        if (!id) continue;

        const canonical = entry.fullUrl || `urn:uuid:${id}`;
        indexByKey[`urn:uuid:${id}`] = canonical;
        indexByKey[`${resourceType}/${id}`] = canonical;
        indexByKey[`./${resourceType}/${id}`] = canonical;
        if (ABS_BASE) indexByKey[`${ABS_BASE}/${resourceType}/${id}`] = canonical;
    }

    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }

        if (typeof node.reference === 'string') {
            const ref = node.reference.trim();
            if (indexByKey[ref]) {
                node.reference = indexByKey[ref];
            } else {
                const match = ref.match(/^([A-Za-z]+)\/([^\/#]+)$/);
                if (match) {
                    const fallback = `${match[1]}/${match[2]}`;
                    if (indexByKey[fallback]) node.reference = indexByKey[fallback];
                }
            }
        }

        for (const key of Object.keys(node)) {
            walk(node[key]);
        }
    };

    walk(bundle);
}

// --- aplicar modo de URL al Bundle (única versión) ---
function applyUrlModeToBundle(bundle, mode = FULLURL_MODE_DOCUMENT, rewriteFn = updateReferencesInObject) {
    if (!bundle?.entry?.length) return new Map();

    // Mapa de reemplazos: cualquier forma conocida -> forma final
    const urlMap = new Map();

    // Detectar bases absolutas reales en el Bundle (normaliza a .../fhir)
    const absoluteBases = new Set();
    for (const e of bundle.entry) {
        if (typeof e.fullUrl === 'string' && /^https?:\/\//i.test(e.fullUrl)) {
            const m = e.fullUrl.match(/^(https?:\/\/[^]+?)(?:\/fhir)?\/[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/);
            if (m && m[1]) absoluteBases.add(`${m[1]}/fhir`);
        }
    }
    if (ABS_BASE) absoluteBases.add(ABS_BASE);

    for (const e of bundle.entry) {
        const r = e.resource;
        if (!r?.resourceType) continue;

        // Resolver id (prefiere el que viene en URN)
        let id = null;
        if (e.fullUrl?.startsWith('urn:uuid:')) id = e.fullUrl.split(':').pop();
        else if (r.id) id = r.id;
        if (!id) {
            id = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
            r.id = id;
        }

        const finalRef = buildRef(mode, r.resourceType, id);
        if (!finalRef) continue;

        // Variantes de la MISMA referencia que deben converger a finalRef
        const variants = new Set([
            e.fullUrl,
            `urn:uuid:${id}`,
            `${r.resourceType}/${id}`,
            `./${r.resourceType}/${id}`,
        ]);
        for (const base of absoluteBases) variants.add(`${base}/${r.resourceType}/${id}`);
        for (const v of variants) if (v) urlMap.set(v, finalRef);

        // Asigna el fullUrl definitivo según "mode"
        e.fullUrl = finalRef;
    }

    rewriteFn(bundle, urlMap);
    checkAndFixReferences(bundle);
    return urlMap;
}

// ===================== Las siguientes funciones ya están definidas arriba =====================

function sortCodingsPreferred_OLD(codings) {
        const pref = [CS_SCT]; // primero SNOMED
        return [...codings].sort((a, b) => {
                const ia = pref.indexOf(a.system);
                const ib = pref.indexOf(b.system);
                return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
}

// ---------------------------------------------------------------------------
// ICVP / IPS / mCSD helpers (pre-validación y ajustes previos al envío)
// ---------------------------------------------------------------------------

// Canonicals y sistemas canónicos (ICVP / mCSD / IPS)
const ICVP_BUNDLE_PROFILE_BASE = 'http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP';
const ICVP_BUNDLE_PROFILE = `${ICVP_BUNDLE_PROFILE_BASE}|0.2.0`;
const ICVP_COMPOSITION_PROFILE = 'http://smart.who.int/icvp/StructureDefinition/Composition-uv-ips-ICVP';
// ⚠️ Código productId exacto según catálogo PreQual
const CS_PREQUAL_PRODUCT_IDS = 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualProductIDs';
// Tipo de vacuna (ICVP VaccineType)
const CS_PREQUAL_VACCINE_TYPE = 'http://smart.who.int/pcmt-vaxprequal/CodeSystem/PreQualVaccineType'; // (igual, confirmado)
// Fallback para "data absent" (evita dependencia del paquete IPS)
const CS_DATA_ABSENT_REASON = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';
// URNs requeridas por mCSD para Organization.type
const URN_MCSJ = 'urn:ihe:iti:mcsd:2019:jurisdiction';
const URN_3986 = 'urn:ietf:rfc:3986';
// ConceptMap de ICVP: ProductId → VaccineType (se usa en el validador)
// https://smart.who.int/icvp/0.2.0/ConceptMap-ICVPProductIdToVaccineType.html
// Mapeo básico de ProductId → VaccineType (extensible según catálogo)
const PREQUAL_PRODUCT_MAP = [
    {
        prefix: 'yellowfeverproduct',
        vaccineTypeCode: 'YellowFever',
        vaccineTypeDisplay: 'Yellow Fever'
    },
    // agrega aquí otros mapeos si los necesitas (COVID-19 XM68M6, etc.)
];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ensureIcvpBundleProfilesAndSlices(bundle) {
    if (!bundle || bundle.resourceType !== 'Bundle') return;

    // Garantiza perfil ICVP para el Bundle
    bundle.meta = bundle.meta || {};
    const existingProfiles = Array.isArray(bundle.meta.profile) ? bundle.meta.profile : [];
    const desiredOrder = [ICVP_BUNDLE_PROFILE_BASE, ICVP_BUNDLE_PROFILE];
    const mergedProfiles = [...desiredOrder];
    for (const profile of existingProfiles) {
        if (profile && !mergedProfiles.includes(profile)) {
            mergedProfiles.push(profile);
        }
    }
    bundle.meta.profile = mergedProfiles;

    // Composition debe ser primer entry
    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    const compIndex = entries.findIndex((entry) => entry?.resource?.resourceType === 'Composition');
    if (compIndex > 0) {
        const [compositionEntry] = entries.splice(compIndex, 1);
        entries.unshift(compositionEntry);
    }
    bundle.entry = entries;

    const compositionEntry = bundle.entry.find((entry) => entry?.resource?.resourceType === 'Composition');
    if (compositionEntry?.resource) {
        const compResource = compositionEntry.resource;

        // 🔧 Asegura que Composition.id refleje exactamente el UUID del fullUrl para cumplir slicing
        if (!compResource.id && compositionEntry.fullUrl?.startsWith('urn:uuid:')) {
            compResource.id = compositionEntry.fullUrl.replace('urn:uuid:', '');
        }

        // 🔧 Reemplaza referencias absolutas (broadcast) por la variante interna correspondiente
        const patientEntry = bundle.entry.find((entry) => entry?.resource?.resourceType === 'Patient');
        if (compResource.subject?.reference?.startsWith('http') && patientEntry?.fullUrl) {
            compResource.subject.reference = patientEntry.fullUrl;
        }

        if (Array.isArray(compResource.author)) {
            const practitionerEntry = bundle.entry.find((entry) => entry?.resource?.resourceType === 'Practitioner');
            compResource.author = compResource.author.map((author) => {
                if (author?.reference?.startsWith('http') && practitionerEntry?.fullUrl) {
                    return { reference: practitionerEntry.fullUrl };
                }
                return author;
            });
        }
    }

    // IPS/ICVP: la primera entry debe tener fullUrl URN alineado con Composition.id
    if (bundle.type === 'document'
        && FULLURL_MODE_DOCUMENT === 'urn'
        && Array.isArray(bundle.entry)
        && bundle.entry[0]
        && bundle.entry[0].resource?.resourceType === 'Composition') {
        const compEntry = bundle.entry[0];
        const compRes = compEntry.resource;
        let compUuid = (compEntry.fullUrl || '').replace(/^urn:uuid:/, '');

        if (!compUuid || !UUID_REGEX.test(compUuid)) {
            compUuid = (compRes.id && UUID_REGEX.test(compRes.id))
                ? compRes.id.replace(/^.*\//, '')
                : uuidv4();
        }

        compEntry.fullUrl = `urn:uuid:${compUuid}`;

        // Si no hay id o no coincide, alinéalo con el UUID del fullUrl
        if (!compRes.id || compRes.id !== compUuid) {
            compRes.id = compUuid;
        }
    }

    // Asegura perfil ICVP para la Composition
    const composition = compositionEntry?.resource;
    if (composition?.resourceType === 'Composition') {
        composition.meta = composition.meta || {};
        const compProfiles = new Set([...(composition.meta.profile || [])]);
        compProfiles.add(ICVP_COMPOSITION_PROFILE);
        composition.meta.profile = Array.from(compProfiles);
    }

    // Remueve display en Organization.type.coding para perfiles JurisdictionOrganization
    for (const entry of bundle.entry || []) {
        const org = entry?.resource;
        if (org?.resourceType !== 'Organization') continue;
        const profs = new Set([...(org.meta?.profile || [])]);
        if (!profs.has('https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.JurisdictionOrganization')) continue;
        for (const type of org.type || []) {
            for (const coding of type.coding || []) {
                if (coding.system && coding.code) delete coding.display;
            }
        }
    }
}

function mapProductIdToPrequalVaccine(productCode) {
    if (!productCode) return null;
    const normalized = String(productCode).trim().toLowerCase();
    return PREQUAL_PRODUCT_MAP.find(({ prefix }) => normalized.startsWith(prefix)) || null;
}

function ensureBundleEntryIdsAreUuids(bundle) {
    const legacyMap = new Map();
    if (!bundle?.entry) return legacyMap;

    for (const entry of bundle.entry) {
        const resource = entry?.resource;
        if (!resource) continue;

        const originalId = resource.id;
        const originalFullUrl = entry.fullUrl;
        let nextId = originalId;

        if (!nextId && typeof originalFullUrl === 'string' && originalFullUrl.startsWith('urn:uuid:')) {
            const candidate = originalFullUrl.split(':').pop();
            if (candidate && UUID_REGEX.test(candidate)) {
                nextId = candidate;
            }
        }

        if (!nextId || !UUID_REGEX.test(nextId)) {
            const newId = uuidv4();
            if (originalId) {
                const relative = `${resource.resourceType}/${originalId}`;
                legacyMap.set(relative, `urn:uuid:${newId}`);
                legacyMap.set(`./${relative}`, `urn:uuid:${newId}`);
                legacyMap.set(`urn:uuid:${originalId}`, `urn:uuid:${newId}`);
                if (ABS_BASE) {
                    legacyMap.set(`${ABS_BASE}/${relative}`, `urn:uuid:${newId}`);
                }
            }
            if (originalFullUrl && originalFullUrl !== `urn:uuid:${newId}`) {
                legacyMap.set(originalFullUrl, `urn:uuid:${newId}`);
            }
            nextId = newId;
        }

        resource.id = nextId;
    }

    return legacyMap;
}

function ensureCompositionLinkages(bundle) {
    if (!bundle?.entry?.length) return;
    const entries = bundle.entry;
    const compositionEntry = entries.find((entry) => entry?.resource?.resourceType === 'Composition');
    const composition = compositionEntry?.resource?.resourceType === 'Composition' ? compositionEntry.resource : null;
    if (!composition) return;

    const patientEntry = entries.find((entry) => entry?.resource?.resourceType === 'Patient');
    if (patientEntry) {
        ensureCompositionSubject(composition, patientEntry);
    }

    const extractEntryId = (entry) => {
        if (!entry) return null;
        if (entry.resource?.id) return entry.resource.id;
        if (typeof entry.fullUrl === 'string') {
            const urn = entry.fullUrl.match(/^urn:uuid:([0-9a-f\-]{36})$/i);
            if (urn) return urn[1];
            const rel = entry.fullUrl.match(/^[A-Za-z]+\/([A-Za-z0-9\-\.]{1,64})$/);
            if (rel) return rel[1];
            const abs = entry.fullUrl.match(/\/([A-Za-z0-9\-\.]{1,64})$/);
            if (abs) return abs[1];
        }
        return null;
    };

    const jurisdictionOrgEntry = entries.find((entry) =>
        entry?.resource?.resourceType === 'Organization' &&
        (entry.resource.meta?.profile || []).includes('https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.JurisdictionOrganization')
    );
    const practitionerEntry = entries.find((entry) => entry?.resource?.resourceType === 'Practitioner');

    const orgRef = (() => {
        const id = extractEntryId(jurisdictionOrgEntry);
        const ref = id ? buildRef('Organization', id) : null;
        return ref || jurisdictionOrgEntry?.fullUrl || null;
    })();

    const practitionerRef = (() => {
        const id = extractEntryId(practitionerEntry);
        const ref = id ? buildRef('Practitioner', id) : null;
        return ref || practitionerEntry?.fullUrl || null;
    })();

    const authorRefs = [];
    if (orgRef) {
        authorRefs.push({ reference: orgRef });
    }
    if (practitionerRef) {
        authorRefs.push({ reference: practitionerRef });
    }
    if (authorRefs.length > 0) {
        composition.author = authorRefs;
    }

    if (orgRef) {
        composition.custodian = { reference: orgRef };
    }
}

function collectBundleReferences(node, accumulator) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((item) => collectBundleReferences(item, accumulator));
        return;
    }
    if (typeof node.reference === 'string') {
        accumulator.add(node.reference);
    }
    for (const key of Object.keys(node)) {
        if (key === 'reference') continue;
        collectBundleReferences(node[key], accumulator);
    }
}

function removeUnusedLacOrganizations(bundle) {
    if (!bundle?.entry?.length) return;
    const usedRefs = new Set();
    collectBundleReferences(bundle, usedRefs);

    bundle.entry = bundle.entry.filter((entry) => {
        if (!entry?.resource || !entry.fullUrl) return true;
        if (entry.resource.resourceType !== 'Organization') return true;
        const profiles = entry.resource.meta?.profile || [];
        const hasLacProfile = profiles.some((profile) => typeof profile === 'string' && profile.includes('lac-organization'));
        if (!hasLacProfile) return true;
        return usedRefs.has(entry.fullUrl);
    });
}

function fixJurisdictionOrganization(org) {
    if (!org || org.resourceType !== 'Organization') return;
    const profile = 'https://profiles.ihe.net/ITI/mCSD/StructureDefinition/IHE.mCSD.JurisdictionOrganization';
    const hasJurisdictionProfile = (org.meta?.profile || []).includes(profile);
    if (!hasJurisdictionProfile) return;

    const codeSystem = 'https://profiles.ihe.net/ITI/mCSD/CodeSystem/IHE.mCSD.Organization.Location.Types';
    org.type = [
        { coding: [{ system: URN_3986, code: URN_MCSJ }] },
        { coding: [{ system: codeSystem, code: 'jurisdiction' }] },
    ];
}

function normalizeBundleReferences(bundle) {
    if (!bundle || bundle.resourceType !== 'Bundle') return;
    const byKey = new Map();
    for (const entry of bundle.entry || []) {
        const resource = entry?.resource;
        const id = resource?.id;
        const type = resource?.resourceType;
        if (!resource || !id || !type) continue;
        const key = `${type}/${id}`;
        const full = entry.fullUrl;
        if (full) {
            byKey.set(full, full);
        }
        const preferred = full?.startsWith('urn:uuid:') ? full : (full || key);
        byKey.set(key, preferred);
        if (full?.startsWith('urn:uuid:')) {
            byKey.set(`urn:uuid:${id}`, full);
        }
    }

    const fixRef = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach(fixRef);
            return;
        }
        if (typeof node !== 'object') return;

        if (node.reference && typeof node.reference === 'string') {
            const ref = node.reference;
            if (byKey.has(ref)) {
                node.reference = byKey.get(ref);
            } else {
                const stripped = ref.replace(/^https?:\/\/[^/]+\/[^/]+\//, '');
                if (byKey.has(stripped)) {
                    node.reference = byKey.get(stripped);
                } else if (/^[A-Za-z]+\/[0-9a-f-]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped)) {
                    const mapped = byKey.get(stripped);
                    if (mapped) node.reference = mapped;
                }
            }
        }

        for (const key of Object.keys(node)) fixRef(node[key]);
    };

    for (const entry of bundle.entry || []) {
        if (entry?.resource) fixRef(entry.resource);
    }

    const composition = bundle.entry?.[0]?.resource;
    if (composition?.resourceType === 'Composition' && Array.isArray(composition.section)) {
        for (const section of composition.section) {
            if (!Array.isArray(section.entry)) continue;
            const seen = new Set();
            section.entry = section.entry.filter((sectionEntry) => {
                const ref = sectionEntry.reference;
                if (!ref) return false;
                if (seen.has(ref)) return false;
                seen.add(ref);
                return true;
            });
        }
    }

    // Normaliza referencias absolutas para apuntar al mismo base configurado
    const normalizeAbsRef = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(normalizeAbsRef);
        if (typeof node !== 'object') return;
        if (typeof node.reference === 'string') {
            const current = node.reference;
            if (/^https?:\/\//i.test(current)) {
                const uuidMatch = current.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (uuidMatch) {
                    const candidate = `urn:uuid:${uuidMatch[0].toLowerCase()}`;
                    if (byKey.has(candidate)) {
                        node.reference = byKey.get(candidate);
                        return;
                    }
                }
            }

            if (ABS_BASE) {
                const match = current.match(/^(https?:\/\/[^]+?)(?:\/fhir)?\/([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/);
                if (match && match[2] && match[3]) {
                    node.reference = `${ABS_BASE}/${match[2]}/${match[3]}`;
                }
            }
        }
        for (const key of Object.keys(node)) normalizeAbsRef(node[key]);
    };

    for (const entry of bundle.entry || []) {
        if (entry?.resource) normalizeAbsRef(entry.resource);
    }
}

function fixPractitionerDegreeDisplay(practitioner) {
    if (!practitioner || practitioner.resourceType !== 'Practitioner') return;
    if (!Array.isArray(practitioner.qualification)) return;
    for (const qualification of practitioner.qualification) {
        const coding = qualification.code?.coding?.find((item) =>
            item.system?.startsWith('http://terminology.hl7.org/CodeSystem/v2-0360') && item.code === 'MD'
        );
        if (coding) coding.display = 'Doctor of Medicine';
    }
}

function ensureIcvpImmunizationCoding(immunization) {
    if (!immunization || immunization.resourceType !== 'Immunization') return;

    // Align ProductID extension with ICVP 0.2.0 canonical values
    const productExtUrl = 'http://smart.who.int/pcmt/StructureDefinition/ProductID';
    const productSystem = CS_PREQUAL_PRODUCT_IDS;
    const vaccineTypeSystem = CS_PREQUAL_VACCINE_TYPE;
    const icd11System = 'http://id.who.int/icd/release/11/mms';
    const officialProductDisplays = {
        YellowFeverProductd8a09f80301dc05e124f99ffe7711fc0:
            '01/01/1987Yellow FeverSTAMARILVial + Ampoule10Sanofi PasteurAgence nationale de sécurité du médicament et des produits de santé'
    };

    immunization.extension = Array.isArray(immunization.extension) ? immunization.extension.filter(Boolean) : [];
    immunization.extension = immunization.extension.filter((ext) => ext.url === productExtUrl);

    if (!immunization.extension.length) {
        immunization.extension.push({
            url: productExtUrl,
            valueCoding: {
                system: productSystem,
                code: 'YellowFeverProductd8a09f80301dc05e124f99ffe7711fc0',
                // ⚠️ Display EXACTO según catálogo oficial WHO PreQual
                display: officialProductDisplays.YellowFeverProductd8a09f80301dc05e124f99ffe7711fc0
            }
        });
    }

    const productExtension = immunization.extension[0];
    productExtension.valueCoding = productExtension.valueCoding || {};
    productExtension.valueCoding.system = productSystem;
    if (!productExtension.valueCoding.code) {
        productExtension.valueCoding.code = 'YellowFeverProductd8a09f80301dc05e124f99ffe7711fc0';
    }
    const officialDisplay = officialProductDisplays[productExtension.valueCoding.code];
    if (officialDisplay) {
        productExtension.valueCoding.display = officialDisplay;
    }

    const productCode = productExtension.valueCoding.code;
    const mapping = mapProductIdToPrequalVaccine(productCode);

    immunization.vaccineCode = immunization.vaccineCode || {};
    immunization.vaccineCode.coding = Array.isArray(immunization.vaccineCode.coding)
        ? immunization.vaccineCode.coding.filter(Boolean)
        : [];

    if (!immunization.vaccineCode.coding.length) {
        immunization.vaccineCode.coding = [
            { system: vaccineTypeSystem, code: 'YellowFever', display: 'Yellow Fever' },
            { system: icd11System, code: 'XM0N24' } // optional ICD-11 coding
        ];
        immunization.vaccineCode.text = 'Yellow Fever';
    }

    if (mapping) {
        const canonicalCoding = {
            system: vaccineTypeSystem,
            code: mapping.vaccineTypeCode,
            display: mapping.vaccineTypeDisplay
        };

        let hasCanonical = false;
        const updatedCodings = immunization.vaccineCode.coding
            .filter((coding) => coding?.system !== vaccineTypeSystem || coding?.code === canonicalCoding.code)
            .map((coding) => {
                if (coding?.system === canonicalCoding.system && coding?.code === canonicalCoding.code) {
                    hasCanonical = true;
                    return { ...coding, display: canonicalCoding.display };
                }
                return coding;
            });

        if (!hasCanonical) {
            updatedCodings.unshift(canonicalCoding);
        }

        immunization.vaccineCode.coding = updatedCodings;
    immunization.vaccineCode.text = canonicalCoding.display;
    } else if (!immunization.vaccineCode.text && immunization.vaccineCode.coding.length > 0) {
        const firstCoding = immunization.vaccineCode.coding[0];
        immunization.vaccineCode.text = firstCoding.display || firstCoding.code || 'ICVP vaccine type';
    }

    const hasIcdCoding = immunization.vaccineCode.coding.some((coding) => coding.system === icd11System);
    if (!hasIcdCoding) {
        immunization.vaccineCode.coding.push({ system: icd11System, code: 'XM0N24' });
    }

    const seenCodings = new Set();
    immunization.vaccineCode.coding = immunization.vaccineCode.coding.filter((coding) => {
        if (!coding?.system || !coding?.code) return false;
        const key = `${coding.system}|${coding.code}`;
        if (seenCodings.has(key)) return false;
        seenCodings.add(key);
        return true;
    });

    if (immunization.location?.display) {
        delete immunization.location.display;
    }
    if (immunization.manufacturer?.display) {
        delete immunization.manufacturer.display;
    }
}

function preValidateAndFixICVP(bundle) {
    ensureIcvpBundleProfilesAndSlices(bundle);

    const legacyRefMap = ensureBundleEntryIdsAreUuids(bundle);
    const refMap = new Map(legacyRefMap);

    for (const entry of bundle.entry || []) {
        const resource = entry?.resource;
        if (resource?.resourceType === 'Location' && resource.meta?.tag) {
            delete resource.meta.tag;
        }
    }

    if (bundle.type === 'document' && FULLURL_MODE_DOCUMENT === 'urn') {
        for (const entry of bundle.entry || []) {
            const resource = entry?.resource;
            if (!resource) continue;
            if (!resource.id) resource.id = uuidv4();
            const targetFullUrl = `urn:uuid:${resource.id}`;
            const previousFullUrl = entry.fullUrl;
            if (previousFullUrl && previousFullUrl !== targetFullUrl) {
                refMap.set(previousFullUrl, targetFullUrl);
            }
            const relative = `${resource.resourceType}/${resource.id}`;
            refMap.set(relative, targetFullUrl);
            refMap.set(`./${relative}`, targetFullUrl);
            const baseVariants = new Set();
            if (ABS_BASE) {
                baseVariants.add(ABS_BASE);
                const trimmedBase = ABS_BASE.replace(/\/fhir$/i, '');
                baseVariants.add(trimmedBase);
            }
            if (previousFullUrl && /^https?:\/\//i.test(previousFullUrl)) {
                const derivedBase = previousFullUrl.replace(/\/[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$/, '');
                baseVariants.add(derivedBase);
                if (!/\/fhir$/i.test(derivedBase)) {
                    baseVariants.add(`${derivedBase}/fhir`);
                }
            }
            for (const base of baseVariants) {
                if (!base) continue;
                const normalizedBase = base.replace(/\/+$/, '');
                if (normalizedBase) {
                    refMap.set(`${normalizedBase}/${relative}`, targetFullUrl);
                }
            }
            refMap.set(`urn:uuid:${resource.id}`, targetFullUrl);
            entry.fullUrl = targetFullUrl;
        }
    }

    if (refMap.size > 0) {
        updateReferencesInObject(bundle, refMap);
    }

    normalizeBundleReferences(bundle);
    ensureCompositionLinkages(bundle);

    for (const entry of bundle.entry || []) {
        const resource = entry?.resource;
        if (!resource) continue;

        if (resource.resourceType === 'Organization') fixJurisdictionOrganization(resource);
        if (resource.resourceType === 'Immunization') ensureIcvpImmunizationCoding(resource);
        if (resource.resourceType === 'Practitioner') fixPractitionerDegreeDisplay(resource);
    }

    removeUnusedLacOrganizations(bundle);
}

const ICVP_DOSE_EXT = 'http://smart.who.int/icvp/StructureDefinition/doseNumberCodeableConcept';
const ICVP_VACCINE_CODE_HINT = 'icvp'; // simple heurístico, ajustar según tu sistema real

function ensureCompositionFirst(summaryBundle) {
    if (!summaryBundle?.entry) return;
    const idx = summaryBundle.entry.findIndex(e => e.resource?.resourceType === 'Composition');
    if (idx > 0) {
        const comp = summaryBundle.entry.splice(idx, 1)[0];
        summaryBundle.entry.unshift(comp);
    }
    // Asegurar que la Composition tenga fullUrl/id coherente
    const first = summaryBundle.entry[0];
    if (first && first.resource?.resourceType === 'Composition') {
        if (!first.fullUrl && first.resource.id) first.fullUrl = `urn:uuid:${first.resource.id}`;
        if (!first.resource.id && first.fullUrl?.startsWith('urn:uuid:')) {
            first.resource.id = first.fullUrl.split(':').pop();
        }
        // asegurar perfil ICVP/LAC si hace falta
        addProfile(first.resource, LAC_PROFILES.COMPOSITION);
    }
}

function removeUnknownDoseExtension(summaryBundle) {
    if (!summaryBundle?.entry) return;
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        if (r.resourceType === 'Immunization' && Array.isArray(r.protocolApplied)) {
            for (const p of r.protocolApplied) {
                if (Array.isArray(p.extension)) {
                    p.extension = p.extension.filter(ext => ext.url !== ICVP_DOSE_EXT);
                    if (p.extension.length === 0) delete p.extension;
                }
            }
        }
    }
}

function warnIfNonIcvpVaccine(summaryBundle) {
    if (!summaryBundle?.entry) return;
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        if (r.resourceType === 'Immunization') {
            const codings = r.vaccineCode?.coding || [];
            const hasIcvp = codings.some(c => (c.system || '').toLowerCase().includes(ICVP_VACCINE_CODE_HINT));
            if (!hasIcvp) {
                console.warn('⚠️ Immunization sin código ICVP detectado. El validador ICVP puede fallar. Añade coding del catálogo ICVP o referencia a InventoryItem.', { id: r.id });
            }
        }
    }
}

function preValidateIcvpBundle(summaryBundle) {
    if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') return;

    // 1) composition first
    ensureCompositionFirst(summaryBundle);

    // 2) quitar extensiones no permitidas en immunizations
    removeUnknownDoseExtension(summaryBundle);

    // 3) advertencias sobre vaccineCode
    warnIfNonIcvpVaccine(summaryBundle);

    // 4) Normalizar Immunization según perfil ICVP (ProductID/VaccineType)
    if (Array.isArray(summaryBundle.entry)) {
        for (const entry of summaryBundle.entry) {
            if (entry?.resource?.resourceType === 'Immunization') {
                ensureIcvpImmunizationCoding(entry.resource);
            }
        }
    }

    // 5) Alinear Composition.subject/author con referencias internas resolubles
    if (Array.isArray(summaryBundle.entry)) {
        const compEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Composition');
        const patEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
        const pracEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Practitioner');
        const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');

        if (compEntry?.resource) {
            if (patEntry?.resource) {
                const pid = patEntry.resource.id || patEntry.fullUrl?.replace(/^urn:uuid:/, '');
                if (pid) compEntry.resource.subject = { reference: buildRef('Patient', pid) };
            }

            const authors = [];
            if (orgEntry?.resource) {
                const oid = orgEntry.resource.id || orgEntry.fullUrl?.replace(/^urn:uuid:/, '');
                if (oid) authors.push({ reference: buildRef('Organization', oid) });
            }
            if (pracEntry?.resource) {
                const prid = pracEntry.resource.id || pracEntry.fullUrl?.replace(/^urn:uuid:/, '');
                if (prid) authors.push({ reference: buildRef('Practitioner', prid) });
            }
            if (authors.length) compEntry.resource.author = authors;
        }
    }

    // 6) Aplicar el modo de URL configurado al bundle completo (urn recomendado para Document)
    applyUrlModeToBundle(summaryBundle, FULLURL_MODE_DOCUMENT, updateReferencesInObject);
}

// ===================== Función para corregir Bundle - INTEGRADA =====================
function fixBundleValidationIssues(summaryBundle) {
    if (!summaryBundle?.entry || !Array.isArray(summaryBundle.entry)) return;

    // 0) QUITAR narrativeLink en recursos IPS con slicing cerrado
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;
        // Aplicamos a tipos que el validador reportó: AllergyIntolerance, MedicationStatement y Condition
        if (['AllergyIntolerance','MedicationStatement','Condition','Immunization'].includes(r.resourceType)) {
            stripNarrativeLinkExtensions(r);
        }
        // LIMPIEZA NUEVA: AllergyIntolerance, Medication y Practitioner
        if (r?.resourceType === 'AllergyIntolerance') sanitizeAllergyIntolerance(r);
        if (r.resourceType === 'Medication') {
            sanitizeMedicationResource(r);
        }
        if (r.resourceType === 'Practitioner') {
            sanitizePractitionerIdentifiers(r);
        }
    }

    // Las URL se normalizan más abajo con applyUrlModeToBundle(), evitando doble canonicalización.

    // === Post-canonicalización: Patient
    const patientEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
    if (patientEntry?.resource) {
        // CRÍTICO: Aplicar fixPatientIdentifiers ANTES de cualquier otra validación
        fixPatientIdentifiers(summaryBundle);

        // Validar que el Patient tenga al menos un identifier con URN OID válido
        const hasValidOidIdentifier = patientEntry.resource.identifier?.some(id =>
            isUrnOid(id.system) && id.value && id.type?.coding?.some(c => c.code === 'MR' || c.code === 'PPN')
        );

        if (!hasValidOidIdentifier) {
            console.warn('⚠️ Patient no tiene identifiers URN OID válidos después de fixPatientIdentifiers');
            // Forzar creación de un identifier básico
            /*patientEntry.resource.identifier = [{
                use: 'usual',                                 // MR debe ser 'usual'
                type: {
                    coding: [{
                        system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                        code: 'MR'
                    }]
                },
                system: toUrnOid('2.16.152'), // OID genérico normalizado a urn:oid.<...>
                value: patientEntry.resource.id || 'unknown'
            }];*/
        }

        ensureLacPatientProfile(patientEntry.resource);
        ensureIpsPatientProfile(patientEntry.resource);
        if (Array.isArray(patientEntry.resource.address)) {
            patientEntry.resource.address.forEach(a => {
                const v = String(a.country || '').trim().toUpperCase();
                if (v === 'CHILE' || v === 'CHILE ' || v === 'CL ') a.country = 'CL';
            });
        }
    }


    // 1. Corregir Composition - asegurar ID y custodian (LAC Bundle)
    summaryBundle.type = summaryBundle.type || 'document';

    const compositionEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');
    if (compositionEntry?.resource) {
        // ID del Composition DEBE empatar con el fullUrl (soporta urn|relative|absolute)
        const fu = String(compositionEntry.fullUrl || '');
        let compId = null;
        if (fu.startsWith('urn:uuid:')) {
            compId = fu.split(':').pop();
        } else if (fu) {
            const parts = fu.split('/').filter(Boolean);
            compId = parts[parts.length - 1] || null;
        }
        if (compId) compositionEntry.resource.id = compId;

        // Asegurar custodian (requerido por el perfil lac-composition)
        if (!compositionEntry.resource.custodian) {
            const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');
            if (orgEntry) {
                compositionEntry.resource.custodian = {
                    reference: orgEntry.fullUrl || `Organization/${orgEntry.resource.id}`
                };
            }
        }

        // Perfiles canónicos
        ensureLacCompositionProfile(compositionEntry.resource);
        ensureLacBundleProfile(summaryBundle);

        // Sujeto del Composition -> Patient
        const patEntryForComp = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
        ensureCompositionSubject(compositionEntry.resource, patEntryForComp);

        // Secciones obligatorias (garantiza al menos una entry válida por slice)
        // Alergias: LOINC 48765-2 → AllergyIntolerance
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.ALLERGIES_SECTION, ['AllergyIntolerance']);

        // Inmunizaciones: LOINC 11369-6 → Immunization
        console.log('--- Ensuring Immunizations section entries');
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.IMMUNIZATIONS_SECTION, ['Immunization']);

        // Problemas activos/lista de problemas: LOINC 11450-4 → Condition
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PROBLEMS_SECTION, ['Condition']);

        // Medicación: LOINC 10160-0 → MedicationStatement o MedicationRequest
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.MEDICATIONS_SECTION, ['MedicationStatement','MedicationRequest']);

        // Antecedentes (Past Illness Hx): LOINC 11348-0 → Condition
        ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PAST_ILLNESS_SECTION, ['Condition']);
    }

    // 2.bis Deduplicar y filtrar entries por tipo permitido en cada sección IPS
    if (compositionEntry?.resource?.section) {
        // Mapa loinc -> tipos permitidos
        const sectionAllowedTypes = {
            [LOINC_CODES.ALLERGIES_SECTION]: ['AllergyIntolerance'],
            [LOINC_CODES.IMMUNIZATIONS_SECTION]: ['Immunization'],
            [LOINC_CODES.MEDICATIONS_SECTION]: ['MedicationStatement','MedicationRequest'],
            [LOINC_CODES.PROBLEMS_SECTION]: ['Condition'],
            [LOINC_CODES.PAST_ILLNESS_SECTION]: ['Condition']
        };
        compositionEntry.resource.section.forEach(sec => {
            const loinc = (sec.code?.coding || []).find(c => c.system === 'http://loinc.org')?.code;
            const allowed = sectionAllowedTypes[loinc] || null;
            if (!Array.isArray(sec.entry)) return;
            const seen = new Set();
            sec.entry = sec.entry.filter(e => {
                const ref = e?.reference || '';
                if (!ref) return false;
                if (seen.has(ref)) return false;     // dedupe
                // Validar que la referencia resuelva a un recurso permitido
                const resolved = summaryBundle.entry?.find(x => {
                    const fu = x.fullUrl || (x.resource?.id ? `${x.resource.resourceType}/${x.resource.id}` : '');
                    return fu === ref || fu?.endsWith(`/${ref.split('/').pop()}`);
                })?.resource;
                if (!resolved) return false;
                if (allowed && !allowed.includes(resolved.resourceType)) return false;
                seen.add(ref);
                return true;
            });
        });
    }

    // 2. Perfiles IPS en recursos referenciados por las secciones para que pasen los discriminadores
    for (const e of summaryBundle.entry) {
        const r = e.resource;
        if (!r) continue;

        // Alergias, Medicación, Problemas (activos/pasados)…
        if (['AllergyIntolerance','Immunization','MedicationStatement','MedicationRequest','Condition','Organization']
            .includes(r.resourceType)) {
            ensureIpsProfile(r);
        }
    }

    // 3. Corregir sección "Historial de Enfermedades Pasadas"
    if (compositionEntry?.resource?.section) {
        const pastIllnessSection = compositionEntry.resource.section.find(s =>
            s.code?.coding?.some(c => c.code === '11348-0')
        );

        if (pastIllnessSection) {
            // Agregar div requerido al text.div
            pastIllnessSection.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><h5>Historial de Enfermedades Pasadas</h5><p>Condiciones médicas previas del paciente.</p></div>';

            // Corregir display del código LOINC
            const loincCoding = pastIllnessSection.code.coding.find(c => c.system === 'http://loinc.org' && c.code === '11348-0');
            if (loincCoding && loincCoding.display === 'History of Past illness Narrative') {
                loincCoding.display = 'History of Past illness note';
            }
        }

        const immunisationSection = compositionEntry.resource.section.find(s =>
            s.code?.coding?.some(c => c.code === '11369-6')
        );

        if (immunisationSection) {
            // Corregir display del código LOINC a la etiqueta publicada en LOINC 2.77
            const loincCoding = immunisationSection.code.coding.find(c => c.system === 'http://loinc.org' && c.code === '11369-6');
            if (loincCoding) {
                loincCoding.display = 'History of Immunization note';
            }
        }
    }

    // 3. Continuar con patientEntry ya procesado en sección 1)

    // 4. Corregir address.country del Patient para cumplir ISO 3166
    if (patientEntry?.resource?.address) {
        patientEntry.resource.address.forEach(addr => {
            if (addr.country === 'Chile') {
                addr.country = 'CL'; // Código ISO 3166-1 alpha-2
            }
        });
    }

    // 5. Corregir Conditions - filtrar OpenMRS y codings sin system
    summaryBundle.entry?.forEach(entry => {
        if (entry.resource?.resourceType === 'Condition' && entry.resource.code?.coding) {
            // Filtrar codings sin system y OpenMRS (problemático para validación IPS/LAC)
            entry.resource.code.coding = entry.resource.code.coding
                .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');

            // Si quedan codings, ordenar con SNOMED primero
            if (entry.resource.code.coding.length > 0) {
                entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
            }
        }
    });

    // 6. Corregir MedicationStatement - agregar system y effective[x]
    summaryBundle.entry?.forEach(entry => {
        if (entry.resource?.resourceType === 'MedicationStatement') {
            // Agregar system a medicationCodeableConcept.coding
            if (entry.resource.medicationCodeableConcept?.coding) {
                entry.resource.medicationCodeableConcept.coding.forEach(coding => {
                    if (!coding.system) {
                        coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                    }
                    // Refuerzo específico para no-medication-info
                    if ((coding.code === 'no-medication-info') || (coding.display === 'No information about medications')) {
                        coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                        coding.code = 'no-medication-info';
                        if (!coding.display) coding.display = 'No information about medications';
                    }
                });
            }

            // Agregar effective[x] requerido por el perfil IPS
            if (!entry.resource.effectiveDateTime && !entry.resource.effectivePeriod) {
                entry.resource.effectiveDateTime = new Date().toISOString();
            }
        }

        // Refuerzo: filtrar OpenMRS y ordenar codings de Condition
        if (entry.resource?.resourceType === 'Condition' && Array.isArray(entry.resource.code?.coding)) {
            entry.resource.code.coding = entry.resource.code.coding
                .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');
            if (entry.resource.code.coding.length > 0) {
                entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
            }
        }


    });

    // 6.bis Corregir AllergyIntolerance - absent/unknown 'no-allergy-info'
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'AllergyIntolerance' && Array.isArray(res.code?.coding)) {
            // 2.1 Filtrar codings sin system y los locales OpenMRS
            res.code.coding = res.code.coding.filter(c =>
                !!c.system && c.system !== 'http://openmrs.org/concepts'
            );
            // 2.2 Si quedan codings, ordenar con SNOMED primero
            if (res.code.coding.length > 0) {
                res.code.coding = sortCodingsPreferred(res.code.coding);
            }
            // 2.3 Refuerzo absent/unknown (mantener)
            res.code.coding.forEach(c => {
                if (c.code === 'no-allergy-info' || c.display === 'No information about allergies') {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                    c.code = 'no-allergy-info';
                    if (!c.display) c.display = 'No information about allergies';
                }
            });
        }
    });

    // 6.ter - Corregir Immunization - absent/unknown 'no-immunization-info'
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'Immunization' && res.vaccineCode?.coding?.length) {
            res.vaccineCode.coding.forEach(c => {
                if (!c.system) {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                }
                if (c.code === 'no-immunization-info' || c.display === 'No information about immunizations') {
                    c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
                    c.code = 'no-immunization-info';
                    if (!c.display) c.display = 'No information about immunizations';
                }
            });
        }
    });

    // Aplicar a todos los Immunization del bundle
    for (const entry of summaryBundle.entry) {
        if (entry.resource?.resourceType === 'Immunization') {
            ensureIcvpForImmunization(entry.resource);
        }
    }

    // 7) Asegurar que todas las referencias internas estén en el Bundle
    checkAndFixReferences(summaryBundle);

    // 7.bis. Sanear meta.source que empiecen con '#' (problemático para validación)
    for (const e of summaryBundle.entry || []) {
        const r = e.resource;
        if (r?.meta?.source && typeof r.meta.source === 'string' && r.meta.source.startsWith('#')) {
            // Opción A: borrar
            delete r.meta.source;

            // O si prefieres Opción B: convertir a una URI canónica del sistema
            // r.meta.source = asFhirBase(process.env.ABSOLUTE_FULLURL_BASE || process.env.FHIR_NODE_URL || 'urn:uuid:' + r.id);
        }
    }

    // 8) Refuerzo: Composition.meta.profile debe contener lac-composition (racsel)
    const LAC_COMPOSITION = LAC_PROFILES.COMPOSITION;
    if (compositionEntry?.resource) {
        compositionEntry.resource.meta = compositionEntry.resource.meta || {};
        compositionEntry.resource.meta.profile = Array.isArray(compositionEntry.resource.meta.profile)
            ? compositionEntry.resource.meta.profile
            : [];
        if (!compositionEntry.resource.meta.profile.includes(LAC_COMPOSITION)) {
            compositionEntry.resource.meta.profile.push(LAC_COMPOSITION);
        }
    }

    // 9) NUEVAS MEJORAS LAC: Patient identifiers con URN OIDs (solo si NO hay identifiers)
    const natOid = LAC_NATIONAL_ID_SYSTEM_OID;   // p.ej. 1.2.36.146.595.217.0.1
    const ppnOid = LAC_PASSPORT_ID_SYSTEM_OID;   // p.ej. 2.16.840.1.113883.4.1
    // Reutilizar patientEntry ya definido anteriormente
    if (patientEntry?.resource && (natOid || ppnOid)) {
        const patient = patientEntry.resource;
        // Si ya hay identifiers (y fixPatientIdentifiers ya corrió), no rehacerlos
        if (Array.isArray(patient.identifier) && patient.identifier.length > 0) {
            // no-op: ya normalizados por fixPatientIdentifiers
        } else {
            // Preservar identifiers originales (si los hubiera) y construir por defecto
            const originalIds = [...(patient.identifier || [])];
            patient.identifier = [];

            // Buscar identifier nacional (MR) existente
            const nationalId = originalIds.find(id =>
                id.type?.coding?.some(c => c.code === 'MR') ||
                id.use === 'official' ||
                id.system?.includes('rut') || id.system?.includes('cedula')
            );

            if (natOid && nationalId) {
                patient.identifier.push({
                    use: 'usual',                                 // MR debe ser 'usual'
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                    system: toUrnOid(natOid),
                    value: nationalId.value || 'unknown'
                });
            }

            // Buscar identifier de pasaporte (PPN) existente
            const passportId = originalIds.find(id =>
                id.type?.coding?.some(c => c.code === 'PPN') ||
                id.system?.includes('passport') || id.system?.includes('pasaporte')
            );

            if (ppnOid && passportId) {
                patient.identifier.push({
                    use: 'official',
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN' }] },
                    system: toUrnOid(ppnOid),
                    value: passportId.value || 'unknown'
                });
            }

            // Si no encontramos identifiers apropiados, crear con valores por defecto
           /*
            if (patient.identifier.length === 0 && natOid) {
                const defaultValue = originalIds[0]?.value || `ID-${patient.id || 'unknown'}`;
                patient.identifier.push({
                    use: 'usual',                                 // MR debe ser 'usual'
                    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                    system: toUrnOid(natOid),
                    value: defaultValue
                });
            }*/
        }
    }

    // 10) Corregir país a códigos ISO2
    fixPatientCountry(summaryBundle);

    // 11) Asegurar MedicationStatement.effectiveDateTime
    summaryBundle.entry?.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'MedicationStatement') {
            if (!res.effectiveDateTime && !res.effectivePeriod) {
                res.effectiveDateTime = new Date().toISOString();
            }
        }
    });

    // 12) VALIDACIÓN FINAL: Verificar que los slices críticos estén correctamente configurados
    const finalValidation = () => {
        // Verificar Bundle.entry[0] = Composition con perfil LAC
        const comp = summaryBundle.entry?.[0];
        if (comp?.resource?.resourceType !== 'Composition') {
            console.error('❌ Bundle.entry[0] debe ser Composition');
            return false;
        }
        if (!comp.resource.meta?.profile?.includes('http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP')) {
            console.error('❌ Composition no tiene perfil ICVP');
            return false;
        }

        // Verificar Bundle.entry[1] = Patient con perfiles LAC e IPS y URN OID
        const pat = summaryBundle.entry?.[1];
        if (pat?.resource?.resourceType !== 'Patient') {
            console.error('❌ Bundle.entry[1] debe ser Patient');
            return false;
        }
        if (!pat.resource.meta?.profile?.includes('http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips')) {
            console.error('❌ Patient no tiene perfil lac-patient');
            return false;
        }
        const hasValidIdentifier = pat.resource.identifier?.some(id => isUrnOid(id.system));
        if (!hasValidIdentifier) {
            console.error('❌ Patient no tiene identifiers con URN OID válidos');
            console.error('Identifiers:', pat.resource.identifier);
            return false;
        }

        return true;
    };

    /*const isValid = finalValidation();
    if (isValid) {
        console.log('✅ Bundle LAC validation passed');
    } else {
        console.error('❌ Bundle LAC validation failed - check console for details');
    }*/
}

function normalizePractitionerResource(prac) {
    if (!prac || prac.resourceType !== 'Practitioner') return;

    const identifiers = [
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PPN",
                        "display": "Passport number"
                    }
                ]
            },
            "value": "P34567890"
        },
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "PRN",
                        "display": "Provider number"
                    }
                ]
            },
            "value": "P2Q3R"
        }
    ];

    const name = [
        {
            "use": "official",
            "family": "Barrios",
            "given": [
                "Gracia"
            ]
        }
    ];

    const address = [
        {
            "text": "Chile",
            "country": "CL"
        }
    ]

    const qualifications = [
        {
            "code": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0360|2.7",
                        "code": "RN",
                        "display": "Registered Nurse"
                    }
                ]
            }
        }
    ]
    prac.meta = {
        "profile": [ "http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips" ]
    }
    prac.identifier = identifiers;
    prac.name = name;
    prac.gender = 'female';
    prac.birthDate = '1927-06-27';
    prac.qualification = qualifications;
    return prac;
}
function normalizeOrganizationResource(orga) {
    if (!orga || orga.resourceType !== 'Organization') return;


    const identifiers = [
        {
            "use": "official",
            "value": "G7H8"
        }
    ];

    const name = [
        {
            "use": "official",
            "family": "Salas",
            "given": [
                "Marcelo"
            ]
        }
    ];

    const address = [
        {
            "line": [
                "Estoril 450"
            ],
            "city": "Región Metropolitana",
            "country": "CL"
        }
    ];

    orga.meta = {
        "profile": [ "http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips" ]
    };
    orga.identifier = identifiers;
    orga.name = 'Clínica Las Condes';
    orga.address = address;
    return orga;
}
function ensureIcvpForImmunization(im) {
    if (!im || im.resourceType !== 'Immunization') return;

    // 1) Extension de identificador de producto ICVP (si falta)
    const icvpExtUrl = 'http://smart.who.int/icvp/StructureDefinition/Immunization-uv-ips-ICVP-productBusinessIdentifier';
    const hasIcvpExt = Array.isArray(im.extension) && im.extension.some(e => String(e.url).startsWith('http://smart.who.int/icvp/StructureDefinition'));
    if (!hasIcvpExt) {
        const productValue = im.vaccineCode?.coding?.[0]?.code || im.id || `${im.performer?.[0]?.actor?.reference || 'unknown'}`;
        im.extension = im.extension || [];
        /*im.extension.unshift({
            url: icvpExtUrl,
            valueIdentifier: {
                system: 'https://extranet.who.int/prequal/vaccines', // heurístico; reemplazar por el sistema ICVP real si lo tienes
                value: productValue
            }
        });*/
    }

    // 2) Garantizar vaccineCode: forzar system = ICD-11 MMS (ICVP exige system+code válidos)
    im.vaccineCode = im.vaccineCode || { coding: [] };
    if (im.vaccineCode.coding.length > 0) {
        // Mantiene code/display existentes, pero asegura system ICD-11 MMS
        if (!im.vaccineCode.coding[0].system) {
          im.vaccineCode.coding[0].system = ICVP_VACCINE_SYSTEM;
        }
    } else {
        // Si no hay coding, inyecta uno válido por defecto (Yellow fever vaccines)
        im.vaccineCode.coding.push({
            system: ICVP_VACCINE_SYSTEM,
            code: 'XM0N24',            // ICD-11 MMS: Yellow fever vaccines
            display: 'Yellow fever vaccines'
        });
    }

    // (Opcional) Normaliza codings subsiguientes sin system a ICD-11 MMS
    if (Array.isArray(im.vaccineCode.coding)) {
        for (let i = 1; i < im.vaccineCode.coding.length; i++) {
            if (!im.vaccineCode.coding[i].system) {
                im.vaccineCode.coding[i].system = ICVP_VACCINE_SYSTEM;
            }
        }
    }
}


function pruneToVaccinesOnly(bundle) {
    if (!bundle?.entry) return;

    const keepTypes = new Set(['Composition', 'Patient', 'Immunization', 'Organization', 'Practitioner']);

    const compEntry = bundle.entry.find(e => e.resource?.resourceType === 'Composition');
    if (compEntry?.resource?.section) {
        for (const sec of compEntry.resource.section) {
            const loinc = (sec.code?.coding || []).find(c => c.system === 'http://loinc.org')?.code;
            if (loinc && loinc !== LOINC_CODES.IMMUNIZATIONS_SECTION) {
                delete sec.entry;
            }
        }
    }

    const needed = new Set();
    const markNeeded = (ref) => {
        if (!ref || typeof ref !== 'string') return;
        needed.add(ref);
        const parts = ref.split('/').filter(Boolean);
        const type = parts[parts.length - 2];
        const id = parts[parts.length - 1];
        if (type && id) {
            needed.add(`${type}/${id}`);
            needed.add(`urn:uuid:${id}`);
        }
    };

    if (compEntry?.resource?.custodian?.reference) {
        markNeeded(compEntry.resource.custodian.reference);
    }

    for (const entry of bundle.entry) {
        const res = entry.resource;
        if (res?.resourceType === 'Immunization') {
            (res.performer || []).forEach(p => markNeeded(p?.actor?.reference));
        }
    }

    const shouldKeep = (entry) => {
        const rt = entry.resource?.resourceType;
        if (!rt) return false;
        if (keepTypes.has(rt) && rt !== 'Organization' && rt !== 'Practitioner') {
            return true;
        }
        if (rt === 'Organization' || rt === 'Practitioner') {
            const candidates = new Set([
                entry.fullUrl,
                entry.resource?.id ? `${rt}/${entry.resource.id}` : null,
                entry.resource?.id ? `urn:uuid:${entry.resource.id}` : null,
            ]);
            for (const cand of candidates) {
                if (cand && needed.has(cand)) {
                    return true;
                }
            }
        }
        return false;
    };

    bundle.entry = bundle.entry.filter(shouldKeep);
}


// ===================== Route ITI-65 =====================
app.post('/icvp/_iti65', async (req, res) => {
  let summaryBundle;

  // 1) Obtener $summary si viene uuid; si no, usar el Bundle entregado
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        `${FHIR_NODE_URL}/fhir/Patient/${req.body.uuid}/$summary`,
        { params: { profile: SUMMARY_ICVP_PROFILE }, httpsAgent: axios.defaults.httpsAgent }
      );
      summaryBundle = resp.data;
    } catch (e) {
      console.error('❌ ERROR fetching summary:', e.response?.data || e.message);
      return res.status(502).json({ error: 'Error fetching summary', details: e.message });
    }
  } else {
    summaryBundle = req.body;
  }

  if (!summaryBundle || summaryBundle.resourceType !== 'Bundle') {
    console.error('❌ Invalid summaryBundle:', JSON.stringify(summaryBundle).slice(0, 200));
    return res.status(400).json({ error: 'Invalid Bundle or missing uuid' });
  }

    //if (String(FEATURE_ICVP_VACCINES_ONLY).toLowerCase() === 'true') {
    //    pruneToVaccinesOnly(summaryBundle);
    //}

    try {

                // ========= Corregir problemas de validación ANTES de PDQm =========
        console.log('🔧 Pre-validating and fixing ICVP Bundle issues...');
        try {
            if (summaryBundle && summaryBundle.resourceType === 'Bundle') {
                preValidateAndFixICVP(summaryBundle);
                preValidateIcvpBundle(summaryBundle);
            }
        } catch (e) {
            console.warn('⚠️ ICVP pre-fix failed (continuing):', e?.message || e);
        }
        console.log('✅ Pre-validation and fixing completed.');
        fixBundleValidationIssues(summaryBundle);
        console.log('✅ Bundle validation issues fixed.');


        // ===== Asegurar perfil LAC Bundle desde el inicio =====
        ensureLacBundleProfile(summaryBundle);

        // ===== Algunos nodos piden sí o sí Composition primero y Bundle.type = "document" =====
        summaryBundle.type = "document";

        // ===== Aplicar modo URL al document bundle =====
        applyUrlModeToBundle(summaryBundle, FULLURL_MODE_DOCUMENT, updateReferencesInObject);
        // ===== Forzar orden de slices (Composition, Patient) y sujeto coherente =====
        //ensureEntrySliceOrder(summaryBundle);
        if (summaryBundle.entry && summaryBundle.entry.length > 0) {
            // Alinear Composition.id con el ID del fullUrl final (urn|relative|absolute)
            const firstEntry = summaryBundle.entry[0];
            if (firstEntry?.resource?.resourceType === 'Composition') {
                const fu = String(firstEntry.fullUrl || '');
                const expectedId = fu.startsWith('urn:uuid:')
                    ? fu.split(':').pop()
                    : fu.split('/').filter(Boolean).pop();
                if (expectedId && firstEntry.resource.id !== expectedId) {
                    firstEntry.resource.id = expectedId;
                }
            }
        }

        // ===== Guard rails: asegurar recursos clave presentes =====
        const hasPatient = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Patient');
        const hasComposition = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Composition');
        if (!hasPatient || !hasComposition) {
            return res.status(400).json({
                error: 'Bundle must include Patient and Composition resources',
                details: {
                    hasPatient, hasComposition
                }
            });
        }



      // ========= Paso opcional 1: PDQm =========
      if (isTrue(FEATURE_PDQ_ENABLED)) {
          const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
          const localPatient = patientEntry?.resource;

          if (localPatient) {
              // Extraer identifiers y ordenarlos por preferencia
              // Solo viene el RUN, no trae más identifier
              const ids = Array.isArray(localPatient.identifier) ? localPatient.identifier : [];

              let idCandidates = pickIdentifiersOrderedForPdqm(ids);
              console.log('PDQm: candidatos ordenados =>', idCandidates.join(' , '));

              // Expandir RUN*: probar [RUN*XXXX, XXXX] y evitar duplicados
              const expandRun = (v) => (typeof v === 'string' && /^RUN\*/i.test(v))
                  ? [v, v.replace(/^RUN\*/i, '')]
                  : [v];
              idCandidates = idCandidates.flatMap(expandRun)
                  .filter((v, i, a) => a.indexOf(v) === i);

              // Empujar al final cualquier value que contenga '*'
              const starScore = (v) => (/\*/.test(String(v)) ? 1 : 0);
              idCandidates.sort((a, b) => starScore(a) - starScore(b));

              let pdqmBundle = null;

              if (idCandidates.length) {
                  for (const cand of idCandidates) {
                      try {
                          console.log(`PDQm: buscando por identifier=${cand}`);
                          const tryBundle = await pdqmFetchBundleByIdentifier(cand);
                          const hasHits = !!tryBundle && (
                              (Array.isArray(tryBundle.entry) && tryBundle.entry.length > 0) ||
                              (typeof tryBundle.total === 'number' && tryBundle.total > 0)
                          );
                          if (hasHits) {
                              pdqmBundle = tryBundle;
                              console.log(`PDQm: resultados encontrados con identifier=${cand}`);
                              break;
                          } else {
                              console.log(`PDQm: sin resultados con identifier=${cand}`);
                          }
                      } catch (e) {
                          console.log(`PDQm: error buscando identifier=${cand} → ${e?.message || e}`);
                      }
                  }
              }

              if (pdqmBundle?.resourceType === 'Bundle' && Array.isArray(pdqmBundle.entry) && pdqmBundle.entry.length > 0) {
                  // Guardar para trazabilidad/debug
                  try {
                      const pdqmFile = path.join(debugDir, `pdqmBundle_${Date.now()}.json`);
                      fs.writeFileSync(pdqmFile, JSON.stringify(pdqmBundle, null, 2));
                      console.log('DEBUG: saved PDQm bundle (no replace) →', pdqmFile);
                  } catch (err) {
                      console.warn('⚠️ No se pudo guardar PDQm bundle en disco:', err.message);
                  }

                  // Marcar si es un bundle sintético de fallback
                  if (isPdqmFallbackBundle(pdqmBundle)) {
                      console.warn('⚠️ PDQm bundle es fallback sintético; se ignora (sin reemplazo)');
                  }

                  // Dejar disponible para uso posterior (p. ej. adjuntar como Binary/DocumentReference)
                  req._pdqmBundle = pdqmBundle;
              } else {
                  console.warn('ℹ️ PDQm: sin resultados con ningún identificador de los candidatos');
              }
          } else {
              console.warn('ℹ️ PDQm: no se encontró recurso Patient en el summaryBundle');
          }
      }

    // ========= Paso opcional 2: Terminología por dominio =========
    await normalizeTerminologyInBundle(summaryBundle);

    // ========= Resto del flujo ITI-65 =========
    const now = new Date().toISOString();
    const ssId = uuidv4();
    const drId = uuidv4();

    // Asegurar ID de Bundle
    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }
    const bundleUrn = `urn:uuid:${originalBundleId}`;

    // Tamaño y hash del resumen
    const bundleString = JSON.stringify(summaryBundle);
    const bundleSize = Buffer.byteLength(bundleString, 'utf8');
    const bundleHash = crypto.createHash('sha256').update(bundleString).digest('base64');

    // FIX #1 — Bundle profile genérico
    // summaryBundle.meta = summaryBundle.meta || {};
    // summaryBundle.meta.profile = ['http://hl7.org/fhir/StructureDefinition/Bundle'];

    // FIX #2 — Remover profiles en entries vacíos
    // summaryBundle.entry.forEach(entry => {
    //   const res = entry.resource;
    //   if (res?.meta) {
    //     if (res.meta.profile) delete res.meta.profile;
    //     if (Object.keys(res.meta).length === 0) delete res.meta;
    //   }
    // });

    // FIX #3 — Sanitize UV/IPS en meds (no tocar Immunization: ICVP exige system)
    summaryBundle.entry.forEach(entry => {
        const res = entry.resource;
        if (res?.resourceType === 'MedicationStatement' && res.medicationCodeableConcept?.coding) {
            // si realmente quieres limpiar systems en meds, deja este bloque.
            // En vacunas NO remover system.
        }
    });

    // URN map para referencias internas
    const urlMap = new Map();
    summaryBundle.entry.forEach(entry => {
        const { resource } = entry;
        const abs = ABS_BASE ? `${ABS_BASE}/${resource.resourceType}/${resource.id}` : `urn:uuid:${resource.id}`;
        urlMap.set(`${resource.resourceType}/${resource.id}`, abs);
    });


    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');

    //modificamos al Practitioner
    const practitionerEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Practitioner');
    let practitioner;

    if (!practitionerEntry) {
        // Crear nuevo Practitioner
        const newPracId = uuidv4();
        practitioner = /*normalizePractitionerResource({
            resourceType: 'Practitioner',
            id: newPracId
        }) || */{ resourceType: 'Practitioner', id: newPracId };

        // Añadir entry al bundle (usar referencia tipo "Practitioner/{id}" para que urlMap lo detecte)
        const pracFullRefKey = `Practitioner/${practitioner.id}`;
        summaryBundle.entry.push({
            fullUrl: ABS_BASE ? `${ABS_BASE}/Practitioner/${practitioner.id}` : `urn:uuid:${practitioner.id}`,
            resource: practitioner
        });

        // Añadir al urlMap (misma forma que las otras entradas: mapea "Practitioner/{id}" -> nodo nacional absoluto)
        if (typeof ABS_BASE === 'string' && ABS_BASE.length > 0) {
            urlMap.set(pracFullRefKey, `${ABS_BASE}/Practitioner/${practitioner.id}`);
        } else {
            // fallback a urn:uuid si no hay nodo configurado
            urlMap.set(pracFullRefKey, `urn:uuid:${practitioner.id}`);
        }
    } else {
        practitioner = practitionerEntry.resource;
        //normalizePractitionerResource(practitioner);
        // Asegurar que exista mapeo si no se creó antes
        const key = `Practitioner/${practitioner.id}`;
        if (!urlMap.has(key)) {
            if (typeof ABS_BASE === 'string' && ABS_BASE.length > 0) {
                urlMap.set(key, `${ABS_BASE}/Practitioner/${practitioner.id}`);
            } else {
                urlMap.set(key, `urn:uuid:${practitioner.id}`);
            }
        }
    }

    // Asegurar que Composition.author incluya al Practitioner creado/normalizado
    if (compositionEntry?.resource) {
        const pracRef = urlMap.get(`Practitioner/${practitioner.id}`) || `Practitioner/${practitioner.id}`;
        // FHIR Composition.author es un array de Reference
        compositionEntry.resource.author = Array.isArray(compositionEntry.resource.author)
            ? compositionEntry.resource.author
            : (compositionEntry.resource.author ? [compositionEntry.resource.author] : []);

        const already = compositionEntry.resource.author.some(a => a.reference === pracRef);
        if (!already) compositionEntry.resource.author.push({ reference: pracRef });
    }

        //modificamos la Organizacion
        // const orgEntries = (summaryBundle.entry || []).filter(e => e.resource?.resourceType === 'Organization');
        // for (const orgEntry of orgEntries) {
        //     const org = orgEntry.resource;
        //     if (!org) continue;
        //     normalizeOrganizationResource(org);
        // }

        // Reescribir todas las referencias en el bundle usando el urlMap (mapea Attachment.url y .reference)
        updateReferencesInObject(summaryBundle, urlMap);
    if (compositionEntry) {
      //add event
        if (!Array.isArray(compositionEntry.resource.event)) compositionEntry.resource.event = [];
        compositionEntry.resource.event.push({
            code: [{
                coding: [{
                    system: 'http://terminology.hl7.org/CodeSystem/v3-ActClass',
                    code: 'PCPR',
                    display: 'care provision'
                }],
                text: 'Resumen clínico generado por ICVP'
            }],
            period: { start: now, end: now}
        });
      compositionEntry.resource.subject.reference = urlMap.get(`Patient/${patientEntry.resource.id}`);

      compositionEntry.resource.section?.forEach(section => {
        section.entry?.forEach(item => {
          if (urlMap.has(item.reference)) item.reference = urlMap.get(item.reference);
        });
      });
    }





    summaryBundle.entry.forEach(entry => {
      const res = entry.resource;
      if (res.subject?.reference && urlMap.has(res.subject.reference)) {
                res.subject.reference = urlMap.get(res.subject.reference);
      }
      if (res.patient?.reference && urlMap.has(res.patient.reference)) {
        res.patient.reference = urlMap.get(res.patient.reference);
      }
    });



    // SubmissionSet
    const submissionSet = {
      resourceType: 'List',
      id: ssId,
      text: {
        status: 'extensions',
        div: `<div xmlns="http://www.w3.org/1999/xhtml">SubmissionSet para el paciente ${patientEntry.resource.id}</div>`
      },
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.SubmissionSet'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      extension: [{
        url: 'https://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-sourceId',
        valueIdentifier: { value: bundleUrn }
      }],
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:oid:${ssId}` }],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // DocumentReference
    const documentReference = {
      resourceType: 'DocumentReference',
      id: drId,
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.DocumentReference'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Resumen clínico en formato DocumentReference</div>'
      },
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: bundleUrn },
      status: 'current',
      type: compositionEntry.resource.type,
      subject: { reference: urlMap.get(`Patient/${patientEntry.resource.id}`) },
      date: summaryBundle.timestamp,
      content: [{
        attachment: {
          contentType: 'application/fhir+json',
          url: bundleUrn,
          size: bundleSize,
          hash: bundleHash
        },
        format: {
          system: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
          code: 'urn:ihe:iti:xds-sd:text:2008'
        }
      }]
    };

    // ProvideBundle (transaction)
    const provideBundle = {
      resourceType: 'Bundle',
      id: uuidv4(),
      meta: {
        profile: ['https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Minimal.ProvideBundle'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]
      },
      type: 'transaction',
      timestamp: now,
      entry: [
        { fullUrl: `urn:uuid:${ssId}`, resource: submissionSet, request: { method: 'POST', url: 'List' } },
        { fullUrl: `urn:uuid:${drId}`, resource: documentReference, request: { method: 'POST', url: 'DocumentReference' } },
        { fullUrl: bundleUrn, resource: summaryBundle, request: { method: 'POST', url: 'Bundle' } },
        { fullUrl: urlMap.get(`Patient/${patientEntry.resource.id}`), resource: patientEntry.resource, request: { method: 'PUT', url: `Patient/${patientEntry.resource.id}` } }
      ]
    };

    // Debug + envío
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      const debugFile = path.join(debugDir, `provideBundle_${Date.now()}.json`);
      fs.writeFileSync(debugFile, JSON.stringify(provideBundle, null, 2));
      console.log('DEBUG: saved →', debugFile);
    } catch (debugErr) {
      console.warn('⚠️ DEBUG: No se pudo guardar el archivo de debug:', debugErr.message);
    }

    const resp = await axios.post(FHIR_NODO_NACIONAL_SERVER, provideBundle, {
      headers: { 'Content-Type': 'application/fhir+json' },
      validateStatus: false
    });
    console.log(`⇒ ITI-65 sent, status ${resp.status}`);
    return res.json({ status: 'sent', code: resp.status });

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.LACPASS_ITI65_PORT_ICVP || 8011;
app.listen(PORT, () => console.log(`LACPASS→ITI65 icvp Mediator listening on port ${PORT}`));
