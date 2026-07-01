# MEOW QR Mediator

Genera la imagen QR del certificado **MeOw** (perfil `LACMedicationStatementMeOw` / IG RACSEL) a partir
de la operación `$meow` del firmador, y decodifica un QR MeOw contra el servicio de decode de lacpass.

## Flujo

```
POST /meow/_generate   { Bundle FHIR con .id, y uno o más MedicationStatement }
        │
        ├─ por cada MedicationStatement.id del Bundle:
        │    GET {MEOW_BASE_URL}/Bundle/{id}/$meow?medicationStatementId={msId}
        │       (firmador, devuelve DocumentReference con HC1)
        └─ genera PNG del QR (paquete "qrcode") a partir de cada HC1

POST /meow/_decode      { qrImage: "<base64>" }  o  { hc1: "HC1:..." }
        │
        ├─ si viene qrImage: decodifica el QR (jsqr + jimp) para obtener el HC1
        └─ POST {MEOW_DECODE_URL}  { include_raw: true, qr_data: hc1 }   (lacpass /decode/hcert)
```

## Endpoints

| Método | Ruta              | Body                                             | Respuesta |
| ------ | ----------------- | ------------------------------------------------- | --------- |
| POST   | `/meow/_generate`  | Bundle FHIR (objeto o string), requiere `.id` y al menos un `MedicationStatement` | JSON `{ bundleId, medicationStatementIds, results: [{ medicationStatementId, ok, qrCodes: [{ hc1, qrCodeDataUrl }] }] }`. Con `?format=png` y un único QR generado en total, responde la imagen PNG directamente. |
| POST   | `/meow/_decode`    | `{ qrImage }` (base64) o `{ hc1 }`                 | JSON `{ hc1, decoded }` con la respuesta del servicio de decode |
| GET    | `/meow/health`     | —                                                  | `{ status: 'ok' }` |

## Variables de entorno

Ver `.env.example`. Principales:

- `MEOW_BASE_URL` (requerida): base FHIR del firmador, ej. `https://signer.nodonacionalph4h-dev.minsal.cl/fhir`.
- `MEOW_DECODE_URL`: servicio de decodificación del HC1 (default `http://lacpass.create.cl:7089/decode/hcert`).
- `MEOW_BASIC_USER` / `MEOW_BASIC_PASS`: auth opcional hacia el firmador.
- `MEOW_QR_ERROR_CORRECTION`: nivel de corrección de errores del QR generado (`L|M|Q|H`, default `M`).

## Ejecución

```bash
npm install && npm start          # puerto 8018 (MEOW_PORT)
# o: docker build -t meow-qr-mediator .
```

Salud: `GET /meow/health` → `{ "status": "ok" }`.
