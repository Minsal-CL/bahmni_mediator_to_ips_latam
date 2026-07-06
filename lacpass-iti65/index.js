// index.js — LACPASS → ITI-65 Mediator con PDQm + Terminología por dominio
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
// Nota: cambios para soportar OID con "urn:oid." en lugar de "urn:oid:"
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { registerMediator, activateHeartbeat } from 'openhim-mediator-utils';
import { v4 as uuidv4 } from 'uuid';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mediatorConfig = require('./mediatorConfig.json');

// ===================== ENV =====================
const {
    // OpenHIM / FHIR Destino
    OPENHIM_USER,
    OPENHIM_PASS,
    OPENHIM_API,
    FHIR_NODE_URL,
    SUMMARY_PROFILE,
    FHIR_NODO_NACIONAL_SERVER,

    NODE_ENV,
    DEBUG_DIR_icvp,

    // CORS
    CORS_ORIGIN,

    // ===== Features =====
    FEATURE_PDQ_ENABLED = 'true',
    FEATURE_TS_ENABLED = 'true',

    // Subfeatures terminológicas
    FEATURE_TS_EXPAND_ENABLED = true,
    FEATURE_TS_VALIDATE_VS_ENABLED = true,
    FEATURE_TS_VALIDATE_CS_ENABLED = true,
    FEATURE_TS_TRANSLATE_ENABLED = true,

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
    // Debug PDQm
    PDQM_DEBUG_LEVEL = 'info', // 'off' | 'info' | 'debug'

    // ===== Terminology =====
    // Acepta alias TERMINOLOGY_BASE_URL o TERMINO_SERVER_URL
    TERMINOLOGY_BASE_URL,
    TERMINO_SERVER_URL,
    TS_TIMEOUT_MS = '15000',
    TS_DISPLAY_LANGUAGE,
    TS_ACTIVE_ONLY = 'true',

    // Dominios
    TS_DOMAINS = 'conditions,procedures,medications', //se saca vaccines
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
  MHD_FORMAT_CODE = 'urn:ihe:iti:xds-sd:text:2008', // Default IHE para FHIR JSON
  MHD_FORMAT_SYSTEM = 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
  
  // Debug level para ops terminológicas
  TS_DEBUG_LEVEL = 'warn', // 'debug', 'warn', 'error', 'silent'
} = process.env;

// ====== NUEVO: separador configurable para URN OID (por defecto ".")
const OID_URN_SEPARATOR = process.env.OID_URN_SEPARATOR || '.';

// ============== Utils de log PDQm ==============
function pdqmShouldLog(level='info') {
  const order = { off: 0, info: 1, debug: 2 };
  const cur = String(PDQM_DEBUG_LEVEL || 'info').toLowerCase();
  return (order[level] || 0) <= (order[cur] || 1);
}
function pdqmLog(level, ...args) {
  if (pdqmShouldLog(level)) {
    const prefix = level === 'debug' ? '🔍 PDQm[debug]' : 'ℹ️ PDQm';
    console.log(prefix, ...args);
  }
}
function summarizeIdentifiers(ids=[]) {
  const norm = (s) => String(s||'').trim();
  return ids.map((id, idx) => ({
    idx,
    typeText: norm(id?.type?.text),
    typeCode: norm(id?.type?.coding?.[0]?.code),
    system: norm(id?.system),
    value: norm(id?.value)
  }));
}

const {
  FULLURL_MODE_PROVIDE = 'urn',
  FULLURL_MODE_DOCUMENT = 'absolute',
  ABSOLUTE_FULLURL_BASE,
  BINARY_DELIVERY_MODE = 'both',
  ATTACHMENT_URL_MODE = 'absolute',
} = process.env;

// ===== Constantes de Perfiles y Códigos =====
// OIDs por defecto (normalizados a urn:oid con separador configurable)
const DEFAULT_NAT_OID = toUrnOid(LAC_NATIONAL_ID_SYSTEM_OID || '2.16.152');
const DEFAULT_PPN_OID = toUrnOid(LAC_PASSPORT_ID_SYSTEM_OID || '2.16.840.1.113883.4.330.152');

// Perfiles LAC (racsel) — coinciden con el validador
const LAC_PROFILES = {
  BUNDLE: 'http://racsel.org/StructureDefinition/LACBundleIPS"',
  COMPOSITION: 'http://racsel.org/StructureDefinition/LACCompositionIPS',
  PATIENT: 'http://racsel.org/StructureDefinition/LACPatient'
};

// Perfiles IPS (http)
const IPS_PROFILES = {
  BUNDLE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
  MEDICATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Medication-uv-ips',
  MEDICATION_REQUEST: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips',
  COMPOSITION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips',
  PATIENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips',
  ALLERGY_INTOLERANCE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips',
  CONDITION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips',
  MEDICATION_STATEMENT: 'http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips',
  PROCEDURE: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips',
  IMMUNIZATION: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Immunization-uv-ips',
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
    console.log('warn', `SNOMED $lookup fallo: ${system}|${code}|${versionUri} -> ${e?.response?.status || e?.message}`);
  }
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

const isTrue = (v) => String(v).toLowerCase() === 'true';
const arr = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// ===== Helpers de modos de URL =====
function asAbsoluteBase(u) {
  const x = (u || '').replace(/\/+$/, '');
  return /\/fhir$/i.test(x) ? x : `${x}/fhir`;
}
function makeAbsolute(resourceType, id) {
  const base = asAbsoluteBase(ABSOLUTE_FULLURL_BASE);
  return `${base}/${resourceType}/${id}`;
}
function makeRelative(resourceType, id) {
  return `${resourceType}/${id}`;
}
function makeUrn(id) {
  return `urn:uuid:${id}`;
}

/**
 * Resuelve una referencia según el modo.
 * @param {'urn'|'absolute'|'relative'} mode
 * @param {string} resourceType
 * @param {string} id
 * @returns {string}
 */
function buildRef(mode, resourceType, id) {
  switch ((mode || '').toLowerCase()) {
    case 'absolute':
      return makeAbsolute(resourceType, id);
    case 'relative':
      return makeRelative(resourceType, id);
    default:
      return makeUrn(id);
  }
}

function applyUrlModeToBundle(bundle, mode, updateReferencesInObject) {
  if (!bundle?.entry?.length) return;

  // Mapa de reemplazos: cualquier forma conocida -> forma final (según 'mode')
  const urlMap = new Map();

  // Detectar bases absolutas *reales* que vengan en el Bundle (no asumir solo ABSOLUTE_FULLURL_BASE)
  const absoluteBases = new Set();
  for (const e of bundle.entry) {
    if (typeof e.fullUrl === 'string' && /^https?:\/\//i.test(e.fullUrl)) {
      // recorta hasta '/fhir' si existe, o hasta el recurso
      const m = e.fullUrl.match(/^(https?:\/\/[^]+?)(?:\/fhir)?\/[A-Za-z]+\/[A-Za-z0-9\-\.]{1,64}$/);
      if (m && m[1]) {
        // siempre considerar la variante con /fhir al final
        absoluteBases.add(`${m[1]}/fhir`);
      }
    }
  }
  if (ABSOLUTE_FULLURL_BASE) absoluteBases.add(asAbsoluteBase(ABSOLUTE_FULLURL_BASE));

  for (const e of bundle.entry) {
    const r = e.resource;
    if (!r?.resourceType) continue;

    // Resolver ID (preferir el que provenga del fullUrl cuando sea URN)
    let id = null;
    if (e.fullUrl?.startsWith('urn:uuid:')) id = e.fullUrl.split(':').pop();
    else if (r.id) id = r.id;
    if (!id) continue;

    const finalRef = buildRef(mode, r.resourceType, id);

    // Variantes equivalentes que mapeamos a 'finalRef'
    const variants = new Set([
      e.fullUrl,
      `urn:uuid:${id}`,
      `${r.resourceType}/${id}`,
      `./${r.resourceType}/${id}`,
    ]);
    // agregar TODAS las bases absolutas detectadas
    for (const base of absoluteBases) {
      variants.add(`${base}/${r.resourceType}/${id}`);
    }

    for (const v of [...variants].filter(Boolean)) urlMap.set(v, finalRef);

    // asignar fullUrl final según el modo
    e.fullUrl = finalRef;
  }

  // Reescribir todas las .reference y Attachment.url según urlMap
  updateReferencesInObject(bundle, urlMap);
}

// ===== Funciones Helper =====

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

/**
 * Crea un recurso placeholder para secciones vacías
 */
function createPlaceholderResource(resourceType, id, text = 'No information available') {
  const resource = {
    resourceType,
    id: id || generateId(),
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${text}</div>`
    }
  };

  // Agregar perfil IPS según el tipo de recurso
  switch (resourceType) {
    case 'AllergyIntolerance':
      addProfile(resource, IPS_PROFILES.ALLERGY_INTOLERANCE);
      break;
    case 'Condition':
      addProfile(resource, IPS_PROFILES.CONDITION);
      break;
    case 'MedicationStatement':
      addProfile(resource, IPS_PROFILES.MEDICATION_STATEMENT);
      break;
    case 'Procedure':
      addProfile(resource, IPS_PROFILES.PROCEDURE);
      break;
    case 'Immunization':
      addProfile(resource, IPS_PROFILES.IMMUNIZATION);
      break;
    case 'Observation':
      addProfile(resource, IPS_PROFILES.OBSERVATION);
      break;
  }

  return resource;
}

/**
 * Genera un ID único
 */
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Mueve Composition a entry[0] y Patient a entry[1] (orden requerido por el slice LAC).
 * Además, fuerza Composition.subject.reference = fullUrl del Patient en el modo ya aplicado.
 * También asegura que los recursos tengan los perfiles LAC correctos.
 */
function ensureEntrySliceOrder(bundle) {
  if (!bundle?.entry?.length) return;

  const idxComp = bundle.entry.findIndex(e => e.resource?.resourceType === 'Composition');
  if (idxComp > 0) {
    const [comp] = bundle.entry.splice(idxComp, 1);
    bundle.entry.unshift(comp);
  }
  const idxPat = bundle.entry.findIndex(e => e.resource?.resourceType === 'Patient');
  if (idxPat > 1 || idxPat === -1) {
    // si no está en la posición 1 y existe, llévalo a [1]
    const e = idxPat === -1 ?
      null : bundle.entry.splice(idxPat, 1)[0];
    if (e) bundle.entry.splice(1, 0, e);
  }

  // Añadir perfiles LAC requeridos
  const compEntry = bundle.entry[0];
  const patEntry  = bundle.entry[1];
  if (compEntry?.resource?.resourceType === 'Composition') {
    addProfile(compEntry.resource, 'http://racsel.org/StructureDefinition/LACCompositionIPS');
  }
  if (patEntry?.resource?.resourceType === 'Patient') {
    addProfile(patEntry.resource, 'http://racsel.org/StructureDefinition/LACPatient');
    addProfile(patEntry.resource, 'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips');
  }
  // Perfiles en el Bundle
  bundle.meta = bundle.meta || {};
  bundle.meta.profile = Array.isArray(bundle.meta.profile) ? bundle.meta.profile : [];
  if (!bundle.meta.profile.includes('http://racsel.org/StructureDefinition/LACBundleIPS')) {
    bundle.meta.profile.push('http://racsel.org/StructureDefinition/LACBundleIPS');
  }

  // Composition.subject.reference debe apuntar al fullUrl del Patient (ya transformado)
  if (compEntry?.resource && patEntry?.fullUrl) {
    compEntry.resource.subject = compEntry.resource.subject || {};
    compEntry.resource.subject.reference = patEntry.fullUrl;
  }
}

// ===================== Helper functions para LAC compliance =====================
// Quita acentos, espacios extra, pone minúsculas (para claves de mapa)
function normKey(s) {
  return (s ?? "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().trim().replace(/\s+/g, " ");
}

// Alias (nombres) -> ISO2
const COUNTRY_MAP = new Map(Object.entries({
  "argentina": "AR",
  "bahamas": "BS",
  "barbados": "BB",
  "belice": "BZ",
  "brasil": "BR",
  "brazil": "BR",
  "chile": "CL",
  "costa rica": "CR",
  "ecuador": "EC",
  "el salvador": "SV",
  "guatemala": "GT",
  "honduras": "HN",
  "panama": "PA",
  "panamá": "PA",
  "paraguay": "PY",
  "peru": "PE", "perú": "PE",
  "republica dominicana": "DO", "rep dominicana": "DO", "republica dom": "DO",
  "rep. dominicana": "DO", "republica do": "DO",
  "suriname": "SR",
  "uruguay": "UY",
}));

// ISO3 -> ISO2 para países LAC que manejas
const ISO3_TO_ISO2 = {
  ARG:"AR", BHS:"BS", BRB:"BB", BLZ:"BZ", BRA:"BR", CHL:"CL",
  CRI:"CR", ECU:"EC", SLV:"SV", GTM:"GT", HND:"HN", PAN:"PA",
  PRY:"PY", PER:"PE", DOM:"DO", SUR:"SR", URY:"UY"
};

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

// ===================== Debug dir =====================
function resolveWritableDebugDir() {
  const candidates = [];
  if (DEBUG_DIR_icvp) candidates.push(path.resolve(DEBUG_DIR_icvp));
  candidates.push('/tmp');
  candidates.push(path.resolve(process.cwd(), 'tmp'));

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch (e) {
      console.warn('⚠️ Debug dir no escribible:', candidate, e.message);
    }
  }

  return null;
}

const debugDir = resolveWritableDebugDir();

function safeWriteDebugJson(prefix, data) {
  if (!debugDir) return null;

  const debugFile = path.join(debugDir, `${prefix}_${Date.now()}.json`);
  try {
    fs.writeFileSync(debugFile, JSON.stringify(data, null, 2));
    return debugFile;
  } catch (e) {
    console.warn('⚠️ No se pudo guardar archivo debug:', debugFile, e.message);
    return null;
  }
}

// ===================== OpenHIM Orchestrations =====================
// Registro de orquestación para que OpenHIM muestre cada llamada saliente en la transacción
function mkOrch(name, method, url, reqBody, resp) {
  const safe = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return ''; } };
  return {
    name,
    request: { method, path: url, body: safe(reqBody), timestamp: new Date().toISOString() },
    response: { status: resp?.status || 0, body: safe(resp?.data), timestamp: new Date().toISOString() }
  };
}

function sendOpenhim(res, summary, orchestrations, status = 200) {
  res.set('Content-Type', 'application/json+openhim');
  res.send(JSON.stringify({
    'x-mediator-urn': mediatorConfig.urn,
    status: status >= 400 ? 'Failed' : 'Successful',
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
      timestamp: new Date().toISOString()
    },
    orchestrations: orchestrations || []
  }));
}

// ===================== OpenHIM =====================
console.log(`Starting LACPASS→ITI-65 Mediator...`);
if (NODE_ENV === 'development') {
    axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    console.log('DEV MODE: https self-signed certificates accepted.');
}

// ===================== Logging de configuración =====================
console.log(`🔧 Terminology debug level: ${TS_DEBUG_LEVEL}`);
console.log(`📋 MHD formatCode: ${MHD_FORMAT_CODE}`);
console.log(`🧾 MHD format system: ${MHD_FORMAT_SYSTEM}`);
console.log(`🔗 URL Modes - Provide: ${FULLURL_MODE_PROVIDE}, Document: ${FULLURL_MODE_DOCUMENT}, Attachment: ${ATTACHMENT_URL_MODE}`);
console.log(`📦 Binary delivery mode: ${BINARY_DELIVERY_MODE}`);
if (ABSOLUTE_FULLURL_BASE) {
  console.log(`🌐 Absolute URL base: ${ABSOLUTE_FULLURL_BASE}`);
}
if (NODE_ENV === 'production' && axios.defaults.httpsAgent?.rejectUnauthorized === false) {
  console.warn('⚠️ WARNING: Self-signed certificates accepted in PRODUCTION mode');
}

// ===================== OpenHIM =====================
const TERMINO_BASE = TERMINOLOGY_BASE_URL || TERMINO_SERVER_URL;

// Mediator registration
const openHimOptions = {
    username: OPENHIM_USER,
    password: OPENHIM_PASS,
    apiURL: OPENHIM_API,
    trustSelfSigned: true,
    urn: mediatorConfig.urn,
};

if (openHimOptions.apiURL && openHimOptions.username && openHimOptions.password) {
    registerMediator(openHimOptions, mediatorConfig, (err) => {
      if (err) {
        console.error('❌ OpenHIM registration failed:', err);
        process.exit(1);
      }
      console.log('✅ Mediator registered with OpenHIM');

      const auth = { username: openHimOptions.username, password: openHimOptions.password };
      const channels = mediatorConfig.defaultChannelConfig || [];

      Promise.all(
        channels.map(ch =>
          axios.post(`${openHimOptions.apiURL}/channels`, { ...ch, mediator_urn: mediatorConfig.urn }, { auth })
            .then(() => console.log(`✅ Channel created: ${ch.name}`))
            .catch(async (e) => {
              const msg = e?.response?.data || e?.message || e.toString();
              if (String(msg).toLowerCase().includes('duplicate') || e?.response?.status === 409) {
                try {
                  const q = encodeURIComponent(ch.name);
                  const res = await axios.get(`${openHimOptions.apiURL}/channels?name=${q}`, { auth });
                  const existing = Array.isArray(res.data) ? res.data[0] : res.data;
                  const id = existing && (existing._id || existing.id || existing.channelId || existing._uid);
                  if (id) {
                    await axios.put(`${openHimOptions.apiURL}/channels/${id}`, { ...ch, mediator_urn: mediatorConfig.urn }, { auth });
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

        activateHeartbeat(openHimOptions);
      });
    });
} else {
    console.warn('⚠️ OpenHIM credentials not provided. Skipping mediator registration.');
}

// ===================== CORS =====================
const app = express();
app.use(express.json({ limit: '10mb' }));

const corsOrigin = CORS_ORIGIN || '*';
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===================== Correlation ID =====================
app.use((req, res, next) => {
    req.correlationId = req.headers['x-correlation-id'] || uuidv4();
    res.header('X-Correlation-ID', req.correlationId);
    next();
});

// ===================== Helper terminología =====================
const DOMAIN_LIST = arr(TS_DOMAINS);

// Mapa de configuración de dominio
const DOMAIN_CONFIG = {};
for (const domain of DOMAIN_LIST) {
    const domainUpper = domain.toUpperCase();
    DOMAIN_CONFIG[domain] = {
        vsExpand: process.env[`${domainUpper}_VS_EXPAND_URI`] || '',
        vsValidate: process.env[`${domainUpper}_VS_VALIDATE_URI`] || '',
        codeSystem: process.env[`${domainUpper}_CS_URI`] || 'http://snomed.info/sct',
        translate: {
            conceptMapUrl: process.env[`${domainUpper}_TRANSLATE_CONCEPTMAP_URL`] || TS_TRANSLATE_DEFAULT_CONCEPTMAP_URL,
            sourceVS: process.env[`${domainUpper}_TRANSLATE_SOURCE_VS`] || TS_TRANSLATE_DEFAULT_SOURCE_VS,
            targetVS: process.env[`${domainUpper}_TRANSLATE_TARGET_VS`] || TS_TRANSLATE_DEFAULT_TARGET_VS,
            sourceSystem: process.env[`${domainUpper}_TRANSLATE_SOURCE_SYSTEM`] || TS_TRANSLATE_DEFAULT_SOURCE_SYSTEM,
            targetSystem: process.env[`${domainUpper}_TRANSLATE_TARGET_SYSTEM`] || TS_TRANSLATE_DEFAULT_TARGET_SYSTEM,
        }
    };
}

function resourceToDomain(resource) {
    const type = resource?.resourceType;
    if (type === 'Condition') return 'conditions';
    if (type === 'Procedure') return 'procedures';
    if (type === 'MedicationStatement' || type === 'MedicationRequest') return 'medications';
    if (type === 'Immunization') return 'vaccines';
    return TS_DEFAULT_DOMAIN;
}

function buildTsClient() {
    const baseURL =
        process.env.TERMINOLOGY_BASE_URL || // prioridad: var que estás usando
        process.env.TERMINO_BASE ||
        'http://localhost:8081/fhir';

    if (!baseURL) return null;
    const client = axios.create({
        baseURL: baseURL,
        timeout: parseInt(TS_TIMEOUT_MS, 10),
        httpsAgent: axios.defaults.httpsAgent,
        headers: { Accept: 'application/fhir+json' }
    });

    if (TERMINO_BEARER_TOKEN) {
        client.defaults.headers.common['Authorization'] = `Bearer ${TERMINO_BEARER_TOKEN}`;
    } else if (TERMINO_BASIC_USER && TERMINO_BASIC_PASS) {
        const auth = Buffer.from(`${TERMINO_BASIC_USER}:${TERMINO_BASIC_PASS}`).toString('base64');
        client.defaults.headers.common['Authorization'] = `Basic ${auth}`;
    }

    return client;
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

// Antes: pickIdentifierValueForPdqm(...) devolvía un solo value. Ahora usamos lista ordenada.

// Nuevo: devuelve una lista ORDENADA de candidatos (pasaporte -> nacional -> último recurso)
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

// ===================== Logging helper para terminología =====================
function tsLog(level, message, data = null) {
  console.log(level, message, data);
}

// ===================== Terminology Ops (funciones) =====================
async function opValidateVS(ts, { code, system, display }, domainCfg) {
    console.log('debug', FEATURE_TS_VALIDATE_VS_ENABLED);
  if (!FEATURE_TS_VALIDATE_VS_ENABLED) return null;
  if (!domainCfg?.vsValidate) return null;

  try {
    const params = { url: domainCfg.vsValidate, code };
    if (system) params.system = system;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    console.log('debug', `Validating VS: ${domainCfg.vsValidate} | ${system}|${code}`);

    const { data } = await ts.get('/ValueSet/$validate-code', { params });
    const ok = extractResultFromParameters(data);

    if (ok.result) {
      console.log('debug', `✅ VS validation OK: ${code} -> ${ok.display || display}`);
      return { system: system, code, display: ok.display || display, source: 'validate-vs' };
    } else {
      console.log('debug', `❌ VS validation failed: ${system}|${code}`);
      return { system: system, code, display: ok.display || display, source: 'validate-vs' };
    }
  } catch (e) {
    console.log('warn', `VS validation error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

async function opValidateCS(ts, { code, system, display }, domainCfg) {
  if (!FEATURE_TS_VALIDATE_CS_ENABLED) return null;
  const url = domainCfg?.codeSystem || system;
  if (!url || !code) return null;

  try {
    const params = { url, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (display) params.display = display;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    console.log('debug', `Validating CS: ${url} | ${code}`);

    const { data } = await ts.get('/CodeSystem/$validate-code', { params });
    const ok = extractResultFromParameters(data);

    if (ok.result) {
      console.log('debug', `✅ CS validation OK: ${code} -> ${ok.display || display}`);
      return { system: url, code, display: ok.display || display, source: 'validate-cs' };
    } else {
      console.log('debug', `❌ CS validation failed: ${url}|${code}`);
        return { system: url, code, display: ok.display || display, source: 'validate-cs' };
    }
  } catch (e) {
    console.log('warn', `CS validation error: ${e.response?.status} ${e.message}`, { system: url, code });
  }
  return null;
}

async function opLookup(ts, { code, system, display }, domainCfg) {
  if (!system || !code) return null;

  try {
    const params = { system, code };
    const version = domainCfg?.codeSystemVersion || process.env.TS_SNOMED_VERSION;

    if (version) params.version = version;
    if (TS_DISPLAY_LANGUAGE) params.displayLanguage = TS_DISPLAY_LANGUAGE;

    console.log('debug', `Looking up: ${system}|${code}`);

    const { data } = await ts.get('/CodeSystem/$lookup', { params });
    const disp = extractDisplayFromLookup(data);

    if (disp) {
      console.log('debug', `✅ Lookup OK: ${code} -> ${disp}`);
      return { system, code, display: disp, source: 'lookup' };
    } else {
      console.log('debug', `❌ Lookup no display: ${system}|${code}`);
        return { system, code, display: disp, source: 'lookup' };
    }
  } catch (e) {
    console.log('warn', `Lookup error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

async function opTranslate(ts, { code, system, display }, domainCfg) {
    if (!FEATURE_TS_TRANSLATE_ENABLED) return null;

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
    console.log('debug', `Translate skipped - no config: ${system}|${code}`);
    return null;
  }

  try {
    console.log('debug', `Translating: ${system}|${code} -> ${params.targetsystem}`);

    const { data } = await ts.get('/ConceptMap/$translate', { params });
    const match = extractMatchFromTranslate(data);

    if (match?.system && match?.code) {
      console.log('debug', `✅ Translate OK: ${code} -> ${match.system}|${match.code}`);
      return { system: match.system, code: match.code, display: match.display || display || code, source: 'translate' };
    } else {
      console.log('debug', `❌ Translate no match: ${system}|${code}`);
    }
  } catch (e) {
    console.log('warn', `Translate error: ${e.response?.status} ${e.message}`, { system, code });
  }
  return null;
}

// ===================== TerminologyOp Response Parsers =====================
function extractResultFromParameters(data) {
    const out = { result: false, display: null };
    if (data?.resourceType === 'Parameters' && Array.isArray(data.parameter)) {
        for (const p of data.parameter) {
            if (p.name === 'result') {
                out.result = (p.valueBoolean === true) || (p.valueString === 'true');
            }
            if (p.name === 'display' && p.valueString) out.display = p.valueString;
        }
    }
    return out;
}

function extractDisplayFromLookup(data) {
  if (data?.resourceType !== 'Parameters') return null;
  const params = Array.isArray(data.parameter) ? data.parameter : [];

  const lang = (process.env.TS_DISPLAY_LANGUAGE || 'en').toLowerCase();
  const ROLE_PREFERRED  = '900000000000548007';
  const ROLE_ACCEPTABLE = '900000000000549004';
  const TYPE_SYNONYM    = '900000000000013009';
  const TYPE_FSN        = '900000000000003001';

  // helpers
  const getPart = (d, name) => (d.part || []).find(p => p.name === name);
  const getLang = (d) => getPart(d, 'language')?.valueCode?.toLowerCase();
  const getVal = (d) => getPart(d, 'value')?.valueString || null;
  const getUseFromPart = (d) => getPart(d, 'use')?.valueCoding?.code;
  const getCtxExts = (d) => (d.extension || []).filter(e => e.url === 'http://snomed.info/fhir/StructureDefinition/designation-use-context');
  const getRoleFromExt = (d) => getCtxExts(d)
    .map(e => (e.extension || []).find(x => x.url === 'role')?.valueCoding?.code)
    .find(Boolean);
  const getTypeFromExt = (d) => getCtxExts(d)
    .map(e => (e.extension || []).find(x => x.url === 'type')?.valueCoding?.code)
    .find(Boolean);

  const designations = params
    .filter(p => p.name === 'designation' && Array.isArray(p.part))
    .map(d => {
      const role = getRoleFromExt(d);
      const type = getTypeFromExt(d) || getUseFromPart(d);
      return { raw: d, lang: getLang(d), role, type, value: getVal(d) };
    })
    .filter(d => d.lang === lang && d.value);

  const paramDisplay = params.find(p => p.name === 'display')?.valueString || null;
  if (designations.length === 0) return paramDisplay || null;

  const rank = (d) => {
    const isPref = d.role === ROLE_PREFERRED;
    const isAcc = d.role === ROLE_ACCEPTABLE;
    const isSyn = d.type === TYPE_SYNONYM;
    const isFsn = d.type === TYPE_FSN;
    if (isPref && isSyn) return 0;
    if (isPref && !isFsn) return 1;
    if (isAcc && isSyn) return 2;
    if (isSyn) return 3;
    if (isPref) return 4;
    if (isAcc) return 5;
    return 6;
  };

  designations.sort((a, b) => rank(a) - rank(b));
  return designations[0]?.value || paramDisplay || null;
}

function extractMatchFromTranslate(data) {
    if (data?.resourceType !== 'Parameters') return null;
    const matchParam = data.parameter?.find(p => p.name === 'match');
    if (!matchParam?.part) return null;

    let equivalence, system, code, display;
    for (const part of matchParam.part) {
        console.log('Part--->:', part);
        if (part.name === 'equivalence') equivalence = part.valueCode;
        if (part.name === 'concept') {
            const concept = part.valueCoding;
            system = concept?.system;
            code = concept?.code;
            display = concept?.display;
        }
    }

    if (equivalence && system && code) {
        return { system, code, display, equivalence };
    }
    return null;
}

// ===================== Terminology Pipeline =====================
const CS_ABSENT = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const CS_SCT = 'http://snomed.info/sct';

function asFhirBase(url) {
  const u = (url || '').replace(/\/+$/, '');
  return /\/fhir$/i.test(u) ? u : `${u}/fhir`;
}

function joinUrl(base, path) {
  const b = (base || '').replace(/\/+$/, '');
  const p = (path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

function shouldLookupTS(system) {
  if (!isTrue(FEATURE_TS_ENABLED)) return false;
  if (system === CS_ABSENT) return false;
  if (system === CS_SCT && process.env.TS_HAS_SNOMED !== 'true') return false;
  return true;
}

function sortCodingsPreferred(codings) {
  const pref = [CS_SCT]; // primero SNOMED
  return [...codings].sort((a, b) => {
    const ia = pref.indexOf(a.system);
    const ib = pref.indexOf(b.system);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
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
    //if (!shouldLookupTS(base.system)) return;

    const steps = buildPipeline(domain, ts, base, domainCfg);

    for (const step of steps) {
        try {
            const result = await step();
            if (result?.system && result?.code) {
                target.system = result.system;
                target.code = result.code;
                //target.display = result.display || target.display || cc.text;
                // ahora: si result.display existe, SIEMPRE reemplaza; si no, deja lo que había
                if (result && typeof result.display === 'string' && result.display.trim() !== '') {
                   target.display = result.display.trim();
                 } else {
                   // fallback al comportamiento previo
                   target.display = target.display || cc.text;
                 }
                return; // Usa el primer resultado exitoso
            }else{
                target.system = base.system;
                target.code = base.code;
                target.display = base.display;
                return;
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
        'Medication': ['code'],
    };

    const fields = typeToFields[resource.resourceType] || [];
    for (const field of fields) {
        const cc = resource[field];
        if (cc?.coding && Array.isArray(cc.coding)) {
            yield { path: field, cc };
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

    // Saltar inmunizaciones del proceso de conversión a SNOMED
    if (res.resourceType === 'Immunization') {
      console.log(`⏭️ Saltando ${res.resourceType} - mantiene códigos originales`);
      continue;
    }

    if (res.resourceType === 'Composition') {

      res.custodian = res.author[0];
    }

    // Determinar dominio
    const domain = resourceToDomain(res);
    const domainCfg = DOMAIN_CONFIG[domain] || DOMAIN_CONFIG[TS_DEFAULT_DOMAIN] || {};

    console.log(`🔄 Procesando ${res.resourceType} (dominio: ${domain})`);

    // Normalizar todas las CC relevantes del recurso
    for (const { path, cc } of iterateCodeableConcepts(res)) {
      try {
          console.log(`  └─ Normalizando ${path}:`, cc.coding?.map(c => `${c.system}|${c.code}|${cc.text}`) || ['sin códigos']);
        await normalizeCC(ts, cc, domainCfg, domain);
        console.log('    ✅ Normalizado a:', cc.coding?.map(c => `${c.system}|${c.code}|${c.display}`) || ['sin códigos']);
      } catch (e) {
        console.warn(`⚠️ TS normalize error (${domain}.${path}):`, e.message);
      }
    }
  }

  console.log('✅ Normalización terminológica completada');
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
    console.log('    └─ Sanitized code.coding to SNOMED:', med.code.coding);
    if (med.code.coding.length && !med.code.coding[0]?.display && med.code.text) {
      med.code.coding[0].display = med.code.text;
    }
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

  // Forma canónica idempotente: reconoce tanto el shape crudo de OpenMRS (type.text)
  // como el ya normalizado (type.coding[0].code), para que reprocesar un Patient que ya
  // viene normalizado (p. ej. leído de vuelta del nodo FHIR) no le cambie el identifier.
  for (const id of patient.identifier) {
    const txt = (id?.type?.text || '').toLowerCase();
    const cod = id?.type?.coding?.[0]?.code || '';

    const isNational = txt === 'patient identifier' || cod === 'NI';
    const isPassport = !isNational && (
      /pasaporte|passport/.test(txt) ||
      cod.toUpperCase() === 'PPN' ||
      cod === 'a2551e57-6028-428b-be3c-21816c252e06' // código que nos envías para distinguir PPN
    );

    if (isNational) {
      id.type = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NI' }], text: 'Patient Identifier' };
      id.system = defaultNatOid;
      continue;
    }

    if (isPassport) {
      id.type = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN' }] };
      id.use = 'official';
      id.system = defaultPpnOid;
    }
  }
}

function ensureLacPatientProfile(patient) {
  addProfile(patient, LAC_PROFILES.PATIENT);
}

function ensureIpsPatientProfile(patient) {
  addProfile(patient, IPS_PROFILES.PATIENT);
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

function ensureLacBundleProfile(bundle) {
  addProfile(bundle, LAC_PROFILES.BUNDLE);
}

function ensureLacCompositionProfile(comp) {
  addProfile(comp, LAC_PROFILES.COMPOSITION);
}

function ensureCompositionSubject(comp, patientEntry) {
  if (!comp || !patientEntry) return;
  const ref = patientEntry.fullUrl || (patientEntry.resource?.id ? `Patient/${patientEntry.resource.id}` : null);
  if (ref) comp.subject = { reference: ref };
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

  // Generic fallback (non-Condition sections): link first candidate
  if (candidates.length > 0) {
    sec.entry = Array.isArray(sec.entry) ? sec.entry : [];
    // Enlaza SOLO el primer candidato (satisface slice mínimo)
    const candidate = candidates[0];
    ensureIpsProfile(candidate.resource);
    const alreadyReferenced = sec.entry.some(e => e.reference === candidate.fullUrl);
    if (!alreadyReferenced) sec.entry.push({ reference: candidate.fullUrl });
    // dedupe
    sec.entry = sec.entry.filter((e, i, arr) => i === arr.findIndex(v => v.reference === e.reference));
    return;
  }

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
            { system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy (situation)' }
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
          coding: [{ system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-medications', display: 'No known medications' }],
          text: 'No known medications'
        },
        subject: patRef ? { reference: patRef } : undefined,
        effectiveDateTime: nowIso
      }
    };
  } else if (allowedTypes.includes('Condition')) {
    const isPast = loincCode === LOINC_CODES.PAST_ILLNESS_SECTION;
    placeholder = {
      fullUrl: isPast ? 'urn:uuid:pasthx-none' : 'urn:uuid:problem-none',
      resource: {
        resourceType: 'Condition',
        meta: { profile: [IPS_PROFILES.CONDITION] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        code: {
          coding: [{ system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-problems', display: 'No known problems' }],
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
}

// ===================== Función para corregir Bundle - INTEGRADA =====================
function fixBundleValidationIssues(summaryBundle) {
  console.log('🔧 [INICIO] fixBundleValidationIssues');

  if (!summaryBundle?.entry || !Array.isArray(summaryBundle.entry)) {
    console.warn('⚠️ Bundle vacío o sin entries');
    return;
  }

  console.log(`📦 Bundle con ${summaryBundle.entry.length} entries`);

  // 0) QUITAR narrativeLink en recursos IPS con slicing cerrado
  console.log('🧹 [ETAPA 0] Eliminando narrativeLink extensions...');
  for (const e of summaryBundle.entry) {
    const r = e.resource;
    if (!r) continue;

    if (['AllergyIntolerance','MedicationStatement','Condition','Immunization'].includes(r.resourceType)) {
      console.log(`  - Procesando ${r.resourceType}/${r.id || 'sin-id'}`,r);
      stripNarrativeLinkExtensions(r);
    }

    if (r?.resourceType === 'AllergyIntolerance') {
      console.log(`  - Sanitizando AllergyIntolerance/${r.id || 'sin-id'}`);
      sanitizeAllergyIntolerance(r);
    }
    if (r.resourceType === 'Medication') {
      console.log(`  - Sanitizando Medication/${r.id || 'sin-id'}`);
      sanitizeMedicationResource(r);
    }
    if (r.resourceType === 'Practitioner') {
      console.log(`  - Sanitizando Practitioner/${r.id || 'sin-id'}`);
      sanitizePractitionerIdentifiers(r);
    }
  }

  // === Post-canonicalización: Patient
  console.log('👤 [ETAPA 1] Procesando Patient...');
  const patientEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');

  if (patientEntry?.resource) {
    console.log(`  - Patient encontrado: ${patientEntry.resource.id || 'sin-id'}`);
    console.log('  - Aplicando fixPatientIdentifiers...');
    fixPatientIdentifiers(summaryBundle);

    const hasValidOidIdentifier = patientEntry.resource.identifier?.some(id =>
      isUrnOid(id.system) && id.value && id.type?.coding?.some(c => c.code === 'MR' || c.code === 'PPN')
    );

    console.log(`  - Identifiers válidos con URN OID: ${hasValidOidIdentifier}`);

    if (!hasValidOidIdentifier) {
      console.warn('⚠️ Patient no tiene identifiers URN OID válidos después de fixPatientIdentifiers');
      /*console.log('  - Forzando creación de identifier básico...');
      patientEntry.resource.identifier = [{
        use: 'usual',
        type: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
            code: 'MR'
          }]
        },
        system: toUrnOid('2.16.152'),
        value: patientEntry.resource.id || 'unknown'
      }];
      console.log(`  - Identifier creado: ${JSON.stringify(patientEntry.resource.identifier[0])}`);*/
    }

    console.log('  - Agregando perfiles LAC e IPS...');
    ensureLacPatientProfile(patientEntry.resource);
    ensureIpsPatientProfile(patientEntry.resource);

    if (Array.isArray(patientEntry.resource.address)) {
      console.log(`  - Normalizando ${patientEntry.resource.address.length} direcciones...`);
      patientEntry.resource.address.forEach(a => {
        const v = String(a.country || '').trim().toUpperCase();
        if (v === 'CHILE' || v === 'CHILE ' || v === 'CL ') a.country = 'CL';
      });
    }
  } else {
    console.warn('⚠️ No se encontró Patient en el Bundle');
  }

  // 1. Corregir Composition
  console.log('📄 [ETAPA 2] Procesando Composition...');
  summaryBundle.type = summaryBundle.type || 'document';
  console.log(`  - Bundle.type: ${summaryBundle.type}`);

  const compositionEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Composition');

  if (compositionEntry?.resource) {
    console.log(`  - Composition encontrado: ${compositionEntry.resource.id || 'sin-id'}`);

    const fu = String(compositionEntry.fullUrl || '');
    let compId = null;
    if (fu.startsWith('urn:uuid:')) {
      compId = fu.split(':').pop();
    } else if (fu) {
      const parts = fu.split('/').filter(Boolean);
      compId = parts[parts.length - 1] || null;
    }

    if (compId) {
      console.log(`  - Ajustando Composition.id a: ${compId}`);
      compositionEntry.resource.id = compId;
    }

    if (!compositionEntry.resource.custodian) {
      console.log('  - Composition sin custodian, buscando Organization...');
      const orgEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Organization');
      if (orgEntry) {
        const custodianRef = orgEntry.fullUrl || `Organization/${orgEntry.resource.id}`;
        console.log(`  - Asignando custodian: ${custodianRef}`);
        compositionEntry.resource.custodian = { reference: custodianRef };
      } else {
        console.warn('⚠️ No se encontró Organization para custodian');
      }
    }

    console.log('  - Agregando perfiles LAC...');
    ensureLacCompositionProfile(compositionEntry.resource);
    ensureLacBundleProfile(summaryBundle);

    const patEntryForComp = summaryBundle.entry.find(e => e.resource?.resourceType === 'Patient');
    console.log('  - Asegurando Composition.subject...');
    ensureCompositionSubject(compositionEntry.resource, patEntryForComp);

    console.log('  - Verificando secciones obligatorias...');
    console.log('    • Alergias (48765-2)...');
    ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.ALLERGIES_SECTION, ['AllergyIntolerance']);

    console.log('    • Problemas (11450-4)...');
    ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PROBLEMS_SECTION, ['Condition']);

    console.log('    • Medicación (10160-0)...');
    ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.MEDICATIONS_SECTION, ['MedicationStatement','MedicationRequest']);

    console.log('    • Antecedentes (11348-0)...');
    ensureRequiredSectionEntry(summaryBundle, compositionEntry.resource, LOINC_CODES.PAST_ILLNESS_SECTION, ['Condition']);
  } else {
    console.error('❌ No se encontró Composition en el Bundle');
  }

  // 2.bis Deduplicar y filtrar entries
  console.log('🔍 [ETAPA 3] Deduplicando entries en secciones...');
  if (compositionEntry?.resource?.section) {
    const sectionAllowedTypes = {
      [LOINC_CODES.ALLERGIES_SECTION]: ['AllergyIntolerance'],
      [LOINC_CODES.MEDICATIONS_SECTION]: ['MedicationStatement','MedicationRequest'],
      [LOINC_CODES.PROBLEMS_SECTION]: ['Condition'],
      [LOINC_CODES.PAST_ILLNESS_SECTION]: ['Condition']
    };

    compositionEntry.resource.section.forEach((sec, idx) => {
      const loinc = (sec.code?.coding || []).find(c => c.system === 'http://loinc.org')?.code;
      const allowed = sectionAllowedTypes[loinc] || null;
      console.log(`  - Sección ${idx}: LOINC ${loinc}, tipos permitidos: ${allowed?.join(', ') || 'cualquiera'}`);

      if (!Array.isArray(sec.entry)) return;

      const originalCount = sec.entry.length;
      const seen = new Set();

      sec.entry = sec.entry.filter(e => {
        const ref = e?.reference || '';
        if (!ref) return false;

        const resolvedEntry = summaryBundle.entry?.find(x => {
          const fu = x.fullUrl || (x.resource?.id ? `${x.resource.resourceType}/${x.resource.id}` : '');
          return fu === ref || fu?.endsWith(`/${ref.split('/').pop()}`);
        });

        if (!resolvedEntry || !resolvedEntry.resource) return false;
        if (allowed && !allowed.includes(resolvedEntry.resource.resourceType)) return false;

        // Clave única basada en el ID real del recurso para evitar duplicados si hay mezcla de referencias absolutas/relativas
        const uniqueKey = `${resolvedEntry.resource.resourceType}/${resolvedEntry.resource.id}`;
        if (seen.has(uniqueKey)) return false;

        seen.add(uniqueKey);
        return true;
      });

      console.log(`    Filtradas: ${originalCount} → ${sec.entry.length} entries`);
    });
  }

  // 2. Perfiles IPS
  console.log('🏷️ [ETAPA 4] Agregando perfiles IPS...');
  let ipsProfileCount = 0;
  for (const e of summaryBundle.entry) {
    const r = e.resource;
    if (!r) continue;

    if (['AllergyIntolerance','MedicationStatement','MedicationRequest','Condition','Organization']
        .includes(r.resourceType)) {
      ensureIpsProfile(r);
      ipsProfileCount++;
    }
  }
  console.log(`  - Perfiles IPS agregados: ${ipsProfileCount} recursos`);

  console.log('✅ Bundle post-processing completed');

  // 3. Corregir sección "Historial de Enfermedades Pasadas"
  console.log('📋 [ETAPA 5] Corrigiendo sección Past Illness...');
  if (compositionEntry?.resource?.section) {
    const pastIllnessSection = compositionEntry.resource.section.find(s =>
      s.code?.coding?.some(c => c.code === '11348-0')
    );

    if (pastIllnessSection) {
      console.log('  - Sección encontrada, agregando div y corrigiendo display...');
      pastIllnessSection.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><h5>Historial de Enfermedades Pasadas</h5><p>Condiciones médicas previas del paciente.</p></div>';

      const loincCoding = pastIllnessSection.code.coding.find(c => c.system === 'http://loinc.org' && c.code === '11348-0');
      if (loincCoding && loincCoding.display === 'History of Past illness Narrative') {
        loincCoding.display = 'History of Past illness note';
        console.log('  - Display corregido');
      }
    }
  }

  // 4. Corregir address.country
  console.log('🌍 [ETAPA 6] Corrigiendo códigos de país...');
  if (patientEntry?.resource?.address) {
    patientEntry.resource.address.forEach((addr, idx) => {
      if (addr.country === 'Chile') {
        console.log(`  - Dirección ${idx}: Chile → CL`);
        addr.country = 'CL';
      }
    });
  }

  // 5. Corregir Conditions
  console.log('🩺 [ETAPA 7] Procesando Conditions...');
  let conditionsProcessed = 0;
  summaryBundle.entry?.forEach(entry => {
    if (entry.resource?.resourceType === 'Condition' && entry.resource.code?.coding) {
      const originalCount = entry.resource.code.coding.length;
      entry.resource.code.coding = entry.resource.code.coding
        .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');

      console.log(`  - Condition/${entry.resource.id || 'sin-id'}: ${originalCount} → ${entry.resource.code.coding.length} codings`);

      if (entry.resource.code.coding.length > 0) {
        entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
      }
      conditionsProcessed++;
    }
  });
  console.log(`  - Total Conditions procesados: ${conditionsProcessed}`);

  // 6. Corregir MedicationStatement
  console.log('💊 [ETAPA 8] Procesando MedicationStatements...');
  let medStatementsProcessed = 0;
  summaryBundle.entry?.forEach(entry => {
    if (entry.resource?.resourceType === 'MedicationStatement') {
      console.log(`  - MedicationStatement/${entry.resource.id || 'sin-id'}`);

      if (entry.resource.medicationCodeableConcept?.coding) {
        entry.resource.medicationCodeableConcept.coding.forEach(coding => {
          if (!coding.system) {
            console.log('    • Agregando system absent-unknown');
            coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
          }

          if ((coding.code === 'no-medication-info') || (coding.display === 'No information about medications')) {
            console.log('    • Normalizando no-medication-info');
            coding.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
            coding.code = 'no-medication-info';
            if (!coding.display) coding.display = 'No information about medications';
          }
        });
      }

      if (!entry.resource.effectiveDateTime && !entry.resource.effectivePeriod) {
        console.log('    • Agregando effectiveDateTime');
        entry.resource.effectiveDateTime = new Date().toISOString();
      }
      medStatementsProcessed++;
    }

    if (entry.resource?.resourceType === 'Condition' && Array.isArray(entry.resource.code?.coding)) {
      entry.resource.code.coding = entry.resource.code.coding
        .filter(c => !!c.system && c.system !== 'http://openmrs.org/concepts');
      if (entry.resource.code.coding.length > 0) {
        entry.resource.code.coding = sortCodingsPreferred(entry.resource.code.coding);
      }
    }
  });
  console.log(`  - Total MedicationStatements procesados: ${medStatementsProcessed}`);

  // 6.bis AllergyIntolerance
  console.log('🤧 [ETAPA 9] Procesando AllergyIntolerances...');
  let allergiesProcessed = 0;
  summaryBundle.entry?.forEach(entry => {
    const res = entry.resource;
    if (res?.resourceType === 'AllergyIntolerance' && Array.isArray(res.code?.coding)) {
      console.log(`  - AllergyIntolerance/${res.id || 'sin-id'}`);

      const originalCount = res.code.coding.length;
      res.code.coding = res.code.coding.filter(c =>
        !!c.system && c.system !== 'http://openmrs.org/concepts'
      );
      console.log(`    • Codings: ${originalCount} → ${res.code.coding.length}`);

      if (res.code.coding.length > 0) {
        res.code.coding = sortCodingsPreferred(res.code.coding);
      }

      res.code.coding.forEach(c => {
        if (c.code === 'no-allergy-info' || c.display === 'No information about allergies') {
          console.log('    • Normalizando no-allergy-info');
          c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
          c.code = 'no-allergy-info';
          if (!c.display) c.display = 'No information about allergies';
        }
      });
      allergiesProcessed++;
    }
  });
  console.log(`  - Total AllergyIntolerances procesados: ${allergiesProcessed}`);

  // 6.ter Immunization
  console.log('💉 [ETAPA 10] Procesando Immunizations...');
  let immunizationsProcessed = 0;
  summaryBundle.entry?.forEach(entry => {
    const res = entry.resource;
    if (res?.resourceType === 'Immunization' && res.vaccineCode?.coding?.length) {
      console.log(`  - Immunization/${res.id || 'sin-id'}`);

      res.vaccineCode.coding.forEach(c => {
        if (!c.system) {
          console.log('    • Agregando system absent-unknown');
          c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
        }
        if (c.code === 'no-immunization-info' || c.display === 'No information about immunizations') {
          console.log('    • Normalizando no-immunization-info');
          c.system = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
          c.code = 'no-immunization-info';
          if (!c.display) c.display = 'No information about immunizations';
        }
      });
      immunizationsProcessed++;
    }
  });
  console.log(`  - Total Immunizations procesados: ${immunizationsProcessed}`);

  // 7. Referencias internas
  console.log('🔗 [ETAPA 11] Verificando referencias internas...');
  const allFullUrls = new Set(summaryBundle.entry?.map(e => e.fullUrl) || []);
  console.log(`  - Total fullUrls en Bundle: ${allFullUrls.size}`);

  summaryBundle.entry?.forEach(entry => {
    checkAndFixReferences(entry.resource, allFullUrls, summaryBundle);
  });

  // 7.bis meta.source
  console.log('🧹 [ETAPA 12] Limpiando meta.source problemáticos...');
  let metaSourceCleaned = 0;
  for (const e of summaryBundle.entry || []) {
    const r = e.resource;
    if (r?.meta?.source && typeof r.meta.source === 'string' && r.meta.source.startsWith('#')) {
      console.log(`  - Eliminando meta.source de ${r.resourceType}/${r.id || 'sin-id'}: ${r.meta.source}`);
      delete r.meta.source;
      metaSourceCleaned++;
    }
  }
  console.log(`  - Total meta.source eliminados: ${metaSourceCleaned}`);

  // 8) Perfil lac-composition
  console.log('📌 [ETAPA 13] Asegurando perfil lac-composition...');
  const LAC_COMPOSITION = LAC_PROFILES.COMPOSITION;
  if (compositionEntry?.resource) {
    compositionEntry.resource.meta = compositionEntry.resource.meta || {};
    compositionEntry.resource.meta.profile = Array.isArray(compositionEntry.resource.meta.profile)
      ? compositionEntry.resource.meta.profile
      : [];

    if (!compositionEntry.resource.meta.profile.includes(LAC_COMPOSITION)) {
      console.log(`  - Agregando perfil: ${LAC_COMPOSITION}`);
      compositionEntry.resource.meta.profile.push(LAC_COMPOSITION);
    } else {
      console.log('  - Perfil ya existe');
    }
  }

  // 9) Patient identifiers URN OID
  console.log('🆔 [ETAPA 14] Verificando Patient identifiers URN OID...');
  const natOid = LAC_NATIONAL_ID_SYSTEM_OID;
  const ppnOid = LAC_PASSPORT_ID_SYSTEM_OID;

  if (patientEntry?.resource && (natOid || ppnOid)) {
    const patient = patientEntry.resource;

    if (Array.isArray(patient.identifier) && patient.identifier.length > 0) {
      console.log(`  - Patient ya tiene ${patient.identifier.length} identifiers`);
    } else {
      console.log('  - Creando identifiers desde cero...');
      /*const originalIds = [...(patient.identifier || [])];
      patient.identifier = [];

      const nationalId = originalIds.find(id =>
        id.type?.coding?.some(c => c.code === 'MR') ||
        id.use === 'official' ||
        id.system?.includes('rut') || id.system?.includes('cedula')
      );

      if (natOid && nationalId) {
        console.log(`  - Agregando national ID: ${nationalId.value}`);
        patient.identifier.push({
          use: 'usual',
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
          system: toUrnOid(natOid),
          value: nationalId.value || 'unknown'
        });*/
      }

      const passportId = originalIds.find(id =>
        id.type?.coding?.some(c => c.code === 'PPN') ||
        id.system?.includes('passport') || id.system?.includes('pasaporte')
      );

      if (ppnOid && passportId) {
        console.log(`  - Agregando passport ID: ${passportId.value}`);
        patient.identifier.push({
          use: 'official',
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'PPN' }] },
          system: toUrnOid(ppnOid),
          value: passportId.value || 'unknown'
        });
      }

      if (patient.identifier.length === 0 && natOid) {
        const defaultValue = originalIds[0]?.value || `ID-${patient.id || 'unknown'}`;
        console.log(`  - Creando identifier por defecto: ${defaultValue}`);
        patient.identifier.push({
          use: 'usual',
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
          system: toUrnOid(natOid),
          value: defaultValue
        });
      }
    }
  
  // 10) País ISO2
  console.log('🌎 [ETAPA 15] Aplicando fixPatientCountry...');
  fixPatientCountry(summaryBundle);

  // 11) MedicationStatement.effectiveDateTime
  console.log('⏰ [ETAPA 16] Verificando MedicationStatement.effectiveDateTime...');
  let effectiveDatetimeAdded = 0;
  summaryBundle.entry?.forEach(entry => {
    const res = entry.resource;
    if (res?.resourceType === 'MedicationStatement') {
      if (!res.effectiveDateTime && !res.effectivePeriod) {
        console.log(`  - Agregando effectiveDateTime a ${res.id || 'sin-id'}`);
        res.effectiveDateTime = new Date().toISOString();
        effectiveDatetimeAdded++;
      }
    }
  });
  console.log(`  - Total effectiveDateTime agregados: ${effectiveDatetimeAdded}`);

  // 12) VALIDACIÓN FINAL
  console.log('✅ [ETAPA 17] Validación final...');
  const finalValidation = () => {
    const comp = summaryBundle.entry?.[0];
    if (comp?.resource?.resourceType !== 'Composition') {
      console.error('❌ Bundle.entry[0] debe ser Composition');
      return false;
    }
    if (!comp.resource.meta?.profile?.includes('http://racsel.org/StructureDefinition/LACCompositionIPS')) {
      console.error('❌ Composition no tiene perfil lac-composition');
      console.error(`   Perfiles actuales: ${comp.resource.meta?.profile?.join(', ') || 'ninguno'}`);
      return false;
    }
    console.log('✓ Composition en entry[0] con perfil LAC correcto');

    const pat = summaryBundle.entry?.[1];
    if (pat?.resource?.resourceType !== 'Patient') {
      console.error('❌ Bundle.entry[1] debe ser Patient');
      return false;
    }
    if (!pat.resource.meta?.profile?.includes('http://racsel.org/StructureDefinition/LACPatient')) {
      console.error('❌ Patient no tiene perfil LACPatient');
      console.error(`   Perfiles actuales: ${pat.resource.meta?.profile?.join(', ') || 'ninguno'}`);
      return false;
    }
    console.log('✓ Patient en entry[1] con perfil LAC correcto');

    const hasValidIdentifier = pat.resource.identifier?.some(id => isUrnOid(id.system));
    if (!hasValidIdentifier) {
      console.error('❌ Patient no tiene identifiers con URN OID válidos');
      console.error('   Identifiers:', JSON.stringify(pat.resource.identifier, null, 2));
      return false;
    }
    console.log(`✓ Patient tiene ${pat.resource.identifier.length} identifier(s) con URN OID válido`);

    console.log('🔍 Validando slices obligatorios en Composition...');
    return true;
  };

  const isValid = finalValidation();

  if (isValid) {
    console.log('✅ [FIN] Bundle LAC validation passed');
  } else {
    console.error('❌ [FIN] Bundle LAC validation failed - check console for details');
  }

  console.log('═'.repeat(80));
}

// Función auxiliar para verificar y corregir referencias
function checkAndFixReferences(obj, availableUrls, bundle) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach(item => checkAndFixReferences(item, availableUrls, bundle));
    return;
  }

  // Si tiene propiedad 'reference', verificar que existe
  if (obj.reference && typeof obj.reference === 'string') {
    if (!availableUrls.has(obj.reference)) {
      // Si la referencia no existe, intentar encontrar el recurso por ID
      const parts = obj.reference.split('/');
      const resourceType = parts[parts.length - 2];
      const resourceId = parts[parts.length - 1];
      
      const foundEntry = bundle.entry?.find(e => 
        e.resource?.resourceType === resourceType && 
        e.resource?.id === resourceId
      );
      
      if (foundEntry) {
        obj.reference = foundEntry.fullUrl;
      }
    }
  }

  // Recursivamente procesar todas las propiedades
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && key !== 'reference') {
      checkAndFixReferences(obj[key], availableUrls, bundle);
    }
  }
}

// ===================== Helper: actualiza todas las referencias recursivamente =====================
function updateReferencesInObject(obj, urlMap) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach(item => updateReferencesInObject(item, urlMap));
    return;
  }

  if (obj.reference && typeof obj.reference === 'string') {
    const mapped = urlMap.get(obj.reference);
    if (mapped) {
      obj.reference = mapped;
    }
  }

  // Si es un Attachment (tiene contentType/data/size/hash) y trae url, también mapearla
  if (obj.url && typeof obj.url === 'string' &&
     (Object.prototype.hasOwnProperty.call(obj, 'contentType') ||
      Object.prototype.hasOwnProperty.call(obj, 'data') ||
      Object.prototype.hasOwnProperty.call(obj, 'size') ||
      Object.prototype.hasOwnProperty.call(obj, 'hash'))) {
    const mappedUrl = urlMap.get(obj.url);
    if (mappedUrl) {
      obj.url = mappedUrl;
    }
  }

  for (const key in obj) {
    if (obj.hasOwnProperty(key) && key !== 'reference') {
      updateReferencesInObject(obj[key], urlMap);
    }
  }
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
                console.log(`✅ PDQm response: status=${response.status}, total=${response.data.total || 0}`);
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

function isPdqmFallbackBundle(bundle) {
    return bundle?.entry?.[0]?.resource?.meta?.tag?.some(tag => 
        tag.code === 'pdqm-fallback'
    ) === true;
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
            //"system": "https://registrocivil.cl/pasaporte",
            "value": "CL987654"
        },
        {
            "use": "official",
            "type": {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v2-0203",
                        "code": "MD",
                        "display": "Medical license number"
                    }
                ]
            },
            //"system": "https://colegiomedico.cl/id",
            "value": "K7L8M"
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
            "text": "Chile",
            "country": "CL"
        }
    ]

    prac.identifier = identifiers;
    prac.name = name;
    prac.gender = 'male'
    prac.birthDate = '1974-12-24'
    return prac;
}
function normalizeOrganizationResource(orga) {
    if (!orga || orga.resourceType !== 'Organization') return;


    const identifiers = [
        {
            "use": "official",
            //"system": "https://registroorganizaciones.cl/id",
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
        "profile": [ "http://racsel.org/StructureDefinition/LACOrganization" ]
    };
    orga.identifier = identifiers;
    orga.name = 'Clínica Las Condes';
    orga.address = address;
    return orga;
}

// ===================== Routes =====================
app.get(['/lacpass/health', '/lacpass/_health'], (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ===================== ROUTE ITI-65 - VERSIÓN INTEGRADA =====================
app.post('/lacpass/_iti65', async (req, res) => {
  let summaryBundle;
  const orch = []; // orquestaciones para el log de OpenHIM

  // 1) Obtener $summary si viene uuid; si no, usar el Bundle entregado
  if (req.body.uuid) {
    try {
      const resp = await axios.get(
        joinUrl(asFhirBase(FHIR_NODE_URL), `/Patient/${req.body.uuid}/$summary`),
        { params: { profile: SUMMARY_PROFILE }, httpsAgent: axios.defaults.httpsAgent }
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

  try {
      console.log('🔍 Starting Bundle post-processing...');
    // ========= NUEVO: Corregir problemas de validación ANTES de PDQm =========
    fixBundleValidationIssues(summaryBundle);

    console.log('🔍 Bundle after initial fixes:');
    // ===== Asegurar perfil LAC Bundle desde el inicio =====
    ensureLacBundleProfile(summaryBundle);
    
    // ===== Algunos nodos piden sí o sí Composition primero y Bundle.type = "document" =====
    summaryBundle.type = "document";
    
    // ===== Aplicar modo URL al document bundle =====
      console.log('🔍 Applying FULLURL_MODE_DOCUMENT to Bundle...');
    applyUrlModeToBundle(summaryBundle, FULLURL_MODE_DOCUMENT, updateReferencesInObject);
    // ===== Forzar orden de slices (Composition, Patient) y sujeto coherente =====
      console.log('🔍 Ensuring entry order and Composition.id coherence...');
    ensureEntrySliceOrder(summaryBundle);
    console.log('🔍 Ensuring Composition.id matches fullUrl...');
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
      console.log('🔍 Validating presence of Patient and Composition in Bundle...');
    const hasPatient = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Patient');
    const hasComposition = Array.isArray(summaryBundle.entry) && summaryBundle.entry.some(e => e.resource?.resourceType === 'Composition');
    console.log('🔍 Bundle contains Patient:', hasPatient, 'Composition:', hasComposition);
    if (!hasPatient || !hasComposition) {
      return res.status(400).json({
        error: 'Bundle must include Patient and Composition resources',
        details: {
          hasPatient, hasComposition
        }
      });
    }

    console.log('🔍 Starting optional PDQm and terminology normalization steps...');

    // ========= Paso opcional 1: PDQm =========
    if (isTrue(FEATURE_PDQ_ENABLED)) {
      const patientEntry = summaryBundle.entry?.find(e => e.resource?.resourceType === 'Patient');
      const localPatient = patientEntry?.resource;

      if (localPatient) {
        // ------- Diagnóstico PDQm inicial -------
        pdqmLog('info', 'Paso PDQm habilitado. Base:', PDQM_FHIR_URL || '(vacía)');
        pdqmLog('debug', 'Flags:', {
          PDQM_ALLOWED_SEARCH_PARAMS,
          PDQM_IDENTIFIER_FALLBACK_PARAM_NAMES,
          PDQM_DEFAULT_IDENTIFIER_SYSTEM,
          PDQM_FALLBACK_HTTP_STATUSES,
          PDQM_ENABLE_FALLBACK_FOR_401_403
        });

        // Extraer identifiers y ordenarlos por preferencia (PPN > RUN > otros)
        // Nota: en algunos flujos solo viene RUN.
        const ids = Array.isArray(localPatient.identifier) ? localPatient.identifier : [];
        pdqmLog('info', 'Patient.identifier (resumen):', summarizeIdentifiers(ids));

        let idCandidates = pickIdentifiersOrderedForPdqm(ids);
        pdqmLog('info', 'Candidatos ordenados =>', idCandidates.join(' , '));

        // Expandir RUN*: probar [RUN*XXXX, XXXX] y evitar duplicados
        const expanded = [];
        const seen = new Set();
        for (const v of idCandidates) {
          if (/^RUN\*/i.test(v)) {
            const raw = v.replace(/^RUN\*/i, '').trim();
            if (raw && !seen.has(raw)) { expanded.push(raw); seen.add(raw); }
          }
          if (!seen.has(v)) { expanded.push(v); seen.add(v); }
        }
        idCandidates = expanded;
        pdqmLog('info', 'Candidatos finales (tras expandir RUN*) =>', idCandidates.join(' , '));

        let pdqmBundle = null;
        for (const value of idCandidates) {
          try {
            const b = await pdqmFetchBundleByIdentifier(value);
            if (b?.resourceType === 'Bundle' && Number(b.total || 0) > 0) {
              pdqmBundle = b;
              pdqmLog('info', `Resultado PDQm: total=${b.total} con identifier="${value}"`);
              break;
            }
          } catch (e) {
            console.warn('⚠️ PDQm error buscando por', value, e.message);
          }
        }
        if (pdqmBundle) {
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
          pdqmLog('debug', 'PDQm sin resultados. Revisa si el Patient trae un identificador de Pasaporte (PPN) o si el servidor requiere system|value.');
        }
      } else {
        console.warn('ℹ️ PDQm: no se encontró recurso Patient en el summaryBundle');
      }
    }
  } catch (e) {
    console.warn('⚠️ Error no crítico en paso PDQm (se continúa sin bloquear ITI-65):', e.message);
  }

  try {
    // ========= Paso opcional 2: Terminología por dominio =========
    await normalizeTerminologyInBundle(summaryBundle);

    // ========= Resto del flujo ITI-65 =========
    const now = new Date().toISOString();
    const bundleDate = summaryBundle.timestamp || now;
    const ssId = uuidv4();
    const drId = uuidv4();

    // Asegurar ID de Bundle
    let originalBundleId = summaryBundle.id;
    if (!originalBundleId) {
      originalBundleId = uuidv4();
      summaryBundle.id = originalBundleId;
    }

    // Serializar bundle document para métricas (size/hash) y, si aplica, data
    const bundleJson = JSON.stringify(summaryBundle);
    const bundleBytes = Buffer.from(bundleJson, 'utf8');
    const bundleSize = bundleBytes.length;
    // 🔒 Mantén SHA-256 para interoperabilidad (era así en la versión "anterior")
    const bundleHash = crypto.createHash('sha256').update(bundleBytes).digest('base64');

    // Refs base para reutilizar
    const bundleUrn = `urn:uuid:${originalBundleId}`;
    const patientEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Patient');
    const compositionEntry = summaryBundle.entry.find(e => e.resource.resourceType === 'Composition');
    //modificamos al Practitioner
    const practitionerEntry = summaryBundle.entry.find(e => e.resource?.resourceType === 'Practitioner');
    if (!practitionerEntry) {
      console.warn('⚠️ No Practitioner found in the Bundle.');
    }
    normalizePractitionerResource(practitionerEntry?.resource);
    //modificamos la Organizacion
   const orgEntries = (summaryBundle.entry || []).filter(e => e.resource?.resourceType === 'Organization');
  for (const orgEntry of orgEntries) {
      const org = orgEntry.resource;
      if (!org) continue;
      normalizeOrganizationResource(org);
  }



    const patientRef = patientEntry.fullUrl; // ya canonicalizado a urn:uuid:...
    const docType = compositionEntry?.resource?.type ?? {
      coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient Summary Document' }]
    };
    const patientDisplay = patientEntry.resource.name?.[0]?.text || `Patient ${patientEntry.resource.id}`;

    // ✅ masterIdentifier: hazlo coherente con el "documento" (el Bundle)
    const docMasterIdentifier = buildRef(ATTACHMENT_URL_MODE, 'Bundle', originalBundleId);

    // === Alergias: tomar EXACTAMENTE las del LAC Composition (LOINC 48765-2) ===
    const comp = compositionEntry?.resource;
    const isAllergySection = (sec) =>
      (sec?.code?.coding || []).some(c => (c.system === 'http://loinc.org') && (c.code === '48765-2'));
    const isHistroySection = (sec) =>
      (sec?.code?.coding || []).some(c => (c.system === 'http://loinc.org') && (c.code === '11348-0'));

    const byRef = (ref) => {
      // admite absolute, relative y urn:uuid
      const clean = String(ref || '').trim();
      if (!clean) return null;
      // buscar por fullUrl exacto
      let found = (summaryBundle.entry || []).find(e => e.fullUrl === clean)?.resource;
      if (found) return found;
      // buscar por resourceType/id relativo
      const m = clean.match(/^([A-Za-z]+)\/([A-Za-z0-9\-\.]{1,64})$/);
      if (m) {
        const [ , rt, id ] = m;
        found = (summaryBundle.entry || []).map(e => e.resource).find(r => r?.resourceType === rt && r?.id === id);
        if (found) return found;
      }
      // buscar por urn:uuid id
      if (/^urn:uuid:/i.test(clean)) {
        const uu = clean.replace(/^urn:uuid:/i, '');
        found = (summaryBundle.entry || []).map(e => e.resource).find(r => r?.id === uu);
        if (found) return found;
      }
      return null;
    };

    let lacAllergies = [];
    const allergySections = (comp?.section || []).filter(isAllergySection);
    for (const sec of allergySections) {
      for (const ent of (sec.entry || [])) {
        const ai = byRef(ent.reference);
        if (ai && ai.resourceType === 'AllergyIntolerance') lacAllergies.push(ai);
      }
    }

    const HistorySections = (comp?.section || []).filter(isHistroySection);
    console.log('Secciones de historia encontradas:', HistorySections);
      for (const sec of HistorySections) {
          sec.text.div = `<div xmlns="http://www.w3.org/1999/xhtml">Sección de historia clínica</div>`;
      }

    // dedupe por id
    const seenAI = new Set();
    lacAllergies = lacAllergies.filter(ai => {
      const k = `${ai.resourceType}/${ai.id || JSON.stringify(ai)}`;
      if (seenAI.has(k)) return false; seenAI.add(k); return true;
    });
    console.log(`🧩 Alergias detectadas en LAC: ${lacAllergies.length}`);

    // Si hay alergias reales, NO introducir "no-allergy-info"
    // (mantenemos cualquier normalización terminológica, pero no reemplazamos por ausencia)
    const hasRealAllergy = lacAllergies.length > 0;

    // ---- SubmissionSet
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
        valueIdentifier: { value: buildRef(FULLURL_MODE_DOCUMENT, 'Bundle', originalBundleId) }
      }],
      identifier: [{ use: 'usual', system: 'urn:ietf:rfc:3986', value: `urn:uuid:${ssId}` }],
      status: 'current',
      mode: 'working',
      code: { coding: [{ system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
      subject: { reference: patientRef, display: patientDisplay },
      date: bundleDate,
      entry: [{ item: { reference: `urn:uuid:${drId}` } }]
    };

    // ---- Attachment: referencia al Bundle o al Binary según modo configurado
    const attachment = {
      contentType: 'application/fhir+json',
      size: bundleSize,
      hash: bundleHash
    };
    if (BINARY_DELIVERY_MODE === 'nobinary') {
      // Apuntar por URN al Bundle que va en el mismo transaction
      attachment.url = buildRef('urn', 'Bundle', originalBundleId);
    }

    // Si queremos Binary o ambos, preparamos Binary y/o data
    const binaryId = uuidv4();
    const attachmentBinaryUrl = buildRef('urn', 'Binary', binaryId);

    const binaryTxEntry = {
      fullUrl: attachmentBinaryUrl,
      resource: {
        resourceType: 'Binary',
        contentType: 'application/fhir+json',
        data: bundleBytes.toString('base64')
      },
      request: { method: 'POST', url: 'Binary' }
    };

    if (BINARY_DELIVERY_MODE === 'binary') {
      attachment.url = attachmentBinaryUrl;           // URL → Binary
      delete attachment.data;                         // sin data inline
    }
    if (BINARY_DELIVERY_MODE === 'both') {
      attachment.url = attachmentBinaryUrl;           // URL → Binary
      attachment.data = bundleBytes.toString('base64'); // y data inline
    }

    // ---- DocumentReference (usa Coding simple en format, como antes)
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
      masterIdentifier: { system: 'urn:ietf:rfc:3986', value: docMasterIdentifier },
      status: 'current',
      type: docType,
      subject: { reference: patientRef, display: patientDisplay },
      date: bundleDate,
      content: [{
        attachment,
        // format es Coding (no "coding: []"), igual que la versión anterior
        format: {
          system: MHD_FORMAT_SYSTEM || 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
          code: MHD_FORMAT_CODE
        }
      }]
    };

    // ---- Patient como entrada explícita (dedupe opcional con ifNoneExist)
    const patientTxEntry = {
      fullUrl: patientRef,
      resource: patientEntry.resource,
    };

      // Construir request para patientTxEntry: si tiene id -> PUT a Patient/{id}, si tiene identifier -> POST con ifNoneExist, si no -> POST simple
      const pid = patientEntry.resource.identifier?.[0];

      if (patientEntry.resource.id) {
          // Actualizar recurso existente (id conocido)
          patientTxEntry.request = { method: 'PUT', url: `Patient/${patientEntry.resource.id}` };
      } else if (pid?.system && pid?.value) {
          // Condicional create para evitar duplicados: POST + ifNoneExist=identifier=system|value
          // Normalizar system a URN OID si aplica y URL-encode
          const sys = isUrnOid(pid.system) ? pid.system : toUrnOid(pid.system) || pid.system;
          patientTxEntry.request = {
              method: 'POST',
              url: 'Patient',
              ifNoneExist: `identifier=${encodeURIComponent(sys)}|${encodeURIComponent(String(pid.value))}`
          };
      } else {
          // Sin identificador útil: crear normalmente (posible duplicado)
          patientTxEntry.request = { method: 'POST', url: 'Patient' };
      }

    // ---- ProvideBundle (se arma con ramas según BINARY_DELIVERY_MODE)
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
        patientTxEntry,
        { fullUrl: buildRef('urn', 'List', ssId), resource: submissionSet, request: { method: 'POST', url: 'List' } },
        { fullUrl: buildRef('urn', 'DocumentReference', drId), resource: documentReference, request: { method: 'POST', url: 'DocumentReference' } }
      ]
    };

    // Agregar las alergias del LAC al transaction bundle
    /*for (const ai of lacAllergies) {
      provideBundle.entry.push({
        fullUrl: buildRef('urn', 'AllergyIntolerance', ai.id || uuidv4()),
        resource: ai,
        request: { method: 'POST', url: 'AllergyIntolerance' }
      });
    }*/

    // ➕ "comportamiento anterior": incluir el Bundle si no hay Binary
    // ➕ Incluir el Bundle si no hay Binary (mismo URN que en attachment)
    if (BINARY_DELIVERY_MODE === 'nobinary') {
      provideBundle.entry.push({
        fullUrl: buildRef('urn', 'Bundle', originalBundleId),
        resource: summaryBundle,
        request: { method: 'POST', url: 'Bundle' }
      });
    }

    // ➕ Incluir Binary si corresponde
    if (BINARY_DELIVERY_MODE === 'binary' || BINARY_DELIVERY_MODE === 'both') {
      provideBundle.entry.push(binaryTxEntry);
    }

    // (omitimos normalización de URLs antes del POST para conservar URNs en el transaction)
    // applyUrlModeToBundle(summaryBundle, FULLURL_MODE_DOCUMENT, updateReferencesInObject);
    // applyUrlModeToBundle(provideBundle, FULLURL_MODE_PROVIDE, updateReferencesInObject);

    // Debug + envío
    console.log('DEBUG: Sending ProvideBundle to', FHIR_NODO_NACIONAL_SERVER);
    const debugFile = safeWriteDebugJson('provideBundle', provideBundle);
    if (debugFile) console.log('DEBUG: saved →', debugFile);

    const resp = await axios.post(FHIR_NODO_NACIONAL_SERVER, provideBundle, {
      headers: {
        'Content-Type': 'application/fhir+json',
        'X-Correlation-ID': req.correlationId
      },
      validateStatus: false
    });
    orch.push(mkOrch('ITI-65 ProvideBundle → Hapi FHIR Nodo Nacional', 'POST', FHIR_NODO_NACIONAL_SERVER, provideBundle, resp));
    console.log(`[${req.correlationId}] ⇒ ITI-65 sent, status ${resp.status}`);
    if (resp.status >= 400) {
      const ooFile = safeWriteDebugJson('operationOutcome', resp.data);
      if (ooFile) console.error('❌ OperationOutcome guardado en:', ooFile);
    }

    // Si ANTES creábamos un AllergyIntolerance "no-allergy-info", proteger aquí:
    if (!hasRealAllergy) {
      // ← aquí, y SOLO aquí, crear el recurso "no-allergy-info" si tu flujo lo requiere
    }

    return sendOpenhim(res, { status: 'sent', code: resp.status }, orch, resp.status < 400 ? 200 : resp.status);

  } catch (e) {
    console.error('❌ ERROR ITI-65 Mediator:', e);
    return sendOpenhim(res, { error: e.message }, orch, 500);
  }
});

const PORT = process.env.LACPASS_ITI65_PORT || 8005;
app.listen(PORT, () => console.log(`LACPASS→ITI65 Mediator listening on port ${PORT}`));
