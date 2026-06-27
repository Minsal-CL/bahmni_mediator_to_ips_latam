# FHIR Forwarder MedicationStatement Mediator

Toma el formulario **Reporte Medicamentos** (observaciones OpenMRS de un Encounter) y construye uno o
más **`MedicationStatement`** FHIR (perfil **`LACMedicationStatementMeOw`** del IG RACSEL). Reenvía
`Patient` y el/los `MedicationStatement` al nodo nacional vía OpenHIM.

## Flujo

```
POST /forwardermedicationstatement/_event  { "uuid": "<Encounter uuid>" }
        │
        ├─ GET  Encounter/{uuid}                       (proxy FHIR OpenMRS)
        ├─ GET  Observation?encounter=Encounter/{uuid}
        └─ PUT  Patient, MedicationStatement(s)         (nodo nacional)
```

## Mapeo (formulario → MedicationStatement)

| Campo Bahmni            | Concepto                              | FHIR                       |
| ----------------------- | ------------------------------------- | -------------------------- |
| Medicamento             | Medication orders (`1282…`, Coded)    | `medicationCodeableConcept` (coding SNOMED + text) |
| Dosis                   | General drug frequency (`165503…`)    | `dosage.text`              |
| Vía de Administración   | Prescription instructions (`165502…`) | `dosage.route.text`        |
| Paciente                | `Encounter.subject`                   | `subject` (automático)     |
| Fecha                   | `Observation.effectiveDateTime`       | `effectiveDateTime` (automático) |
| Estado                  | constante `MS_STATUS`                 | `status`                   |

> `status` es constante configurable; `subject`/`effectiveDateTime` automáticos.
> El binding de medicamento es SNOMED — el obs codificado debe traer su coding `http://snomed.info/sct`.

## Alcance (IG ReporteMedicamentos)

- **Fase 1:** recurso clínico `MedicationStatement` (`LACMedicationStatementMeOw`) → `PUT` al nodo.
- **Fase 2 (MS_MHD_ENABLED=true):** ensambla el documento MHD y lo POSTea como transacción:
  - `Composition` (`LACCompositionMeOw`): type LOINC `56445-0`, status `final`, sección "Medicamentos" (`55112-7`) → entries a los MedicationStatement.
  - `Bundle` documento (`LACBundleDocMeOw`, type `document`): Composition + MedicationStatement(s) + Patient + Organization autora.
  - `DocumentReference` (`LACDocReferenceMeOw`) + `List` (SubmissionSet).
  - `Bundle` transacción (`LACBundleTransactionMHDMeOw`, type `transaction`) → `POST` a `MS_MHD_ENDPOINT` (ITI-65).

> ⚠️ La Fase 2 está implementada según los perfiles del IG pero **debe validarse contra el validador
> RACSEL / tu nodo MHD** — el resolver de referencias cross-bundle (subject del DocumentReference,
> identifiers) suele requerir ajustes finos. Si tu MHD lo maneja el `lacpass-iti65`, apunta
> `MS_MHD_ENDPOINT` a ese canal.

## Ejecución

```bash
npm install && npm start          # puerto 8017
# o: docker build -t fhir-forwarder-medicationstatement .
```

Salud: `GET /forwardermedicationstatement/_health` → `OK`.
