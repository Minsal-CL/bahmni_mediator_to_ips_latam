# FHIR Forwarder ServiceRequest Mediator

Toma el formulario **Interconsulta Transfronteriza** (observaciones OpenMRS de un Encounter) y
construye un **`ServiceRequest`** FHIR (R4), referenciando el **último IPS** del paciente — obtenido
por **ITI-67** igual que el dashboard *IPS LAC*. Reenvía `Patient`, `Practitioner`, `Encounter` y el
`ServiceRequest` al nodo nacional vía OpenHIM.

## Flujo

```
POST /forwarderservicerequest/_event  { "uuid": "<Encounter uuid>" }
        │
        ├─ GET  Encounter/{uuid}                      (proxy FHIR OpenMRS)
        ├─ GET  Observation?encounter=Encounter/{uuid}
        ├─ GET  Patient/{id}                          → identificador nacional (RUN/RUT)
        ├─ GET  {IPS_REGIONAL_BASE}/DocumentReference?patient.identifier=…&type=60591-5&_sort=-_lastUpdated&_count=1   (ITI-67)
        └─ PUT  Patient, Practitioner, Encounter, ServiceRequest   (nodo nacional)
```

## Mapeo (formulario → ServiceRequest)

| Campo Bahmni                | Origen                                            | FHIR                         |
| --------------------------- | ------------------------------------------------- | ---------------------------- |
| Fecha de solicitud          | `Observation.effectiveDateTime` / `Encounter`     | `authoredOn` (automático)    |
| Paciente                    | `Encounter.subject`                               | `subject` (automático)       |
| Profesional solicitante     | `Observation.performer` / `Encounter.participant` | `requester` (automático)     |
| Especialidad / Referido a   | obs **Referred to** (`…042`)                      | `code.text`                  |
| Tipo de derivación          | constante `SR_CATEGORY_TEXT`                      | `category`                   |
| Motivo clínico              | obs **Reason for referral (text)** (`164359…`)    | `reasonCode.text`            |
| Texto de carta              | obs **Relevant clinical history** (`…043`)        | `note.text`                  |
| País destino                | obs **Pais de destino** (Coded)                   | `contained Organization.address.country` |
| Organización destino        | obs **Organización de destino** (Text)            | `contained Organization.name` + `performer` |
| IPS generado                | último `DocumentReference` (ITI-67)               | `supportingInfo`             |
| Estado                      | constante `SR_STATUS`                             | `status`                     |

> `status`, `intent` y `category` son constantes configurables (FHIR R4 exige `status` e `intent`).
> No se requieren conceptos nuevos: todo sale de los obs existentes o es automático del recurso.

## Configuración

Copia `.env.example` a `.env` y ajusta credenciales/endpoints. Variables clave:
`FHIR_PROXY_URL`, `FHIR_NODE_URL`, `IPS_REGIONAL_BASE`, `OPENHIM_USER/PASS`, `SR_STATUS/INTENT/CATEGORY_TEXT`.

## Ejecución

```bash
npm install
npm start            # escucha en FORWARDER_SERVICEREQUEST_PORT (8016)
# o con Docker:
docker build -t fhir-forwarder-servicerequest .
```

Salud: `GET /forwarderservicerequest/_health` → `OK`.
