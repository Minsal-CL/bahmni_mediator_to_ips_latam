import requests, feedparser, time, os, re, json
import urllib3
from dotenv import load_dotenv

# Desactivar warnings de certificados self-signed
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Cargar variables de entorno
load_dotenv()

FEED_URL = os.getenv("ATOM_FEED_URL")
OPENHIM_EVENT_ENDPOINT = os.getenv("OPENHIM_ITI_ENDPOINT")
OPENHIM_IMMUNIZATION_ENDPOINT = os.getenv("OPENHIM_IMMUNIZATION_ENDPOINT")
OPENHIM_MEDICATIONREQUEST_ENDPOINT = os.getenv("OPENHIM_MEDICATIONREQUEST_ENDPOINT")
OPENHIM_CONDITION_ENDPOINT = os.getenv("OPENHIM_CONDITION_ENDPOINT")
OPENHIM_PROCEDURE_ENDPOINT = os.getenv("OPENHIM_PROCEDURE_ENDPOINT")
OPENHIM_SERVICEREQUEST_ENDPOINT = os.getenv("OPENHIM_SERVICEREQUEST_ENDPOINT")
OPENHIM_MEDICATIONSTATEMENT_ENDPOINT = os.getenv("OPENHIM_MEDICATIONSTATEMENT_ENDPOINT")
FEED_POLL_INTERVAL = int(os.getenv("FEED_POLL_INTERVAL", "15"))
OPENMRS_USER = os.getenv("OPENMRS_USER")
OPENMRS_PASS = os.getenv("OPENMRS_PASS")
OPENHIM_USER = os.getenv("OPENHIM_USER")
OPENHIM_PASS = os.getenv("OPENHIM_PASS")

DEBUG_FEED_RESPONSE = os.getenv("DEBUG_FEED_RESPONSE", "false").strip().lower() in ("1", "true", "yes", "y")

# Persistencia de entries ya procesadas
SEEN_FILE = "seen_entries.json"
try:
    with open(SEEN_FILE, "r") as f:
        seen_entries = set(json.load(f))
except Exception:
    seen_entries = set()


def save_seen_entries():
    try:
        with open(SEEN_FILE, "w") as f:
            json.dump(list(seen_entries), f)
    except Exception as e:
        print(f"[ERROR] Guardando seen_entries: {e}")


def extract_encounter_uuid_from_content(entry):
    entry_id = entry.get('id') or entry.get('tag')
    print(f"[DEBUG] Analizando entry: {entry_id}")
    content = entry.get('content')
    if content:
        val = content[0].value
        print(f"[DEBUG] Content de entry: {val[:150]}...")
        m = re.search(r'/bahmniencounter/([0-9a-fA-F\-]{36})', val)
        if m:
            uuid = m.group(1)
            print(f"[INFO] UUID extraído: {uuid}")
            return uuid
        print("[WARN] No se encontró UUID con regex")
    else:
        print("[WARN] Entry sin content")
    return None


def post_uuid_to_endpoint(name, url, uuid):
    """Envía el UUID a un endpoint si está definido."""
    if not url:
        print(f"[SKIP] {name}: no definido en variables de entorno.")
        return False, None

    print(f"[INFO] Enviando UUID {uuid} a {name}: {url}")
    try:
        resp = requests.post(
            url,
            json={"uuid": uuid},
            auth=(OPENHIM_USER, OPENHIM_PASS) if OPENHIM_USER else None,
            timeout=10,
            verify=False
        )
        if resp.status_code in (200, 202):
            print(f"✅ {name} OK: {uuid} | Status: {resp.status_code}")
            return True, resp.status_code
        else:
            print(f"[ERROR] {name} devolvió status: {resp.status_code} | Body: {resp.text}")
            return False, resp.status_code
    except Exception as e:
        print(f"[ERROR] Al notificar a {name}: {e}")
        return False, None


def notify_all_endpoints(uuid):
    """
    Notifica el mismo UUID a todos los endpoints declarados.
    - ITI (OPENHIM_ITI_ENDPOINT)
    - Immunization (OPENHIM_IMMUNIZATION_ENDPOINT)
    - MedicationRequest (OPENHIM_MEDICATIONREQUEST_ENDPOINT)
    - Condition (OPENHIM_CONDITION_ENDPOINT)
    - Procedure (OPENHIM_PROCEDURE_ENDPOINT)
    - ServiceRequest (OPENHIM_SERVICEREQUEST_ENDPOINT)
    """
    endpoints = [
        ("ITI", OPENHIM_EVENT_ENDPOINT),
        ("IMMUNIZATION", OPENHIM_IMMUNIZATION_ENDPOINT),
        ("MEDICATIONREQUEST", OPENHIM_MEDICATIONREQUEST_ENDPOINT),
        ("CONDITION", OPENHIM_CONDITION_ENDPOINT),
        ("PROCEDURE", OPENHIM_PROCEDURE_ENDPOINT),
        ("SERVICEREQUEST", OPENHIM_SERVICEREQUEST_ENDPOINT),
        ("MEDICATIONSTATEMENT", OPENHIM_MEDICATIONSTATEMENT_ENDPOINT),
    ]

    results = {}
    for name, url in endpoints:
        ok, status = post_uuid_to_endpoint(name, url, uuid)
        results[name] = {"ok": ok, "status": status}
    return results


def process_feed(feed):
    print(f"[INFO] Procesando feed con {len(feed.entries)} entries...")
    for entry in feed.entries:
        entry_id = entry.get('id') or entry.get('tag')
        if entry_id in seen_entries:
            print(f"[DEBUG] Entry ya procesado: {entry_id}")
            continue

        # Marcamos como visto (mantiene comportamiento original)
        seen_entries.add(entry_id)
        save_seen_entries()

        uuid = extract_encounter_uuid_from_content(entry)
        if not uuid:
            print(f"[WARN] No se pudo extraer UUID de entry: {entry_id}")
            continue

        results = notify_all_endpoints(uuid)
        # Log resumen
        resumen = ", ".join([f"{k}:{'OK' if v['ok'] else 'ERR'}({v['status']})" for k, v in results.items()])
        print(f"[INFO] Resultado notificaciones [{uuid}]: {resumen}")


def get_feed():
    print(f"[INFO] Solicitando feed desde: {FEED_URL}")
    auth = (OPENMRS_USER, OPENMRS_PASS) if OPENMRS_USER else None
    try:
        r = requests.get(
            FEED_URL,
            auth=auth,
            verify=False,
            timeout=10
        )
        print(f"[INFO] Código de respuesta del feed: {r.status_code}")
        if r.status_code == 200:
            content_type = r.headers.get("Content-Type")
            if content_type:
                print(f"[INFO] Content-Type del feed: {content_type}")

            parsed = feedparser.parse(r.text)
            if getattr(parsed, "bozo", False):
                print(f"[WARN] feedparser bozo=True (posible XML malformado o HTML): {getattr(parsed, 'bozo_exception', None)}")

            if DEBUG_FEED_RESPONSE:
                snippet = (r.text or "")[:500].replace("\n", " ").replace("\r", " ")
                print(f"[DEBUG] Snippet response (500 chars): {snippet}")

            # Si parece HTML, normalmente es login page o error proxy que igual devuelve 200
            body_lc = (r.text or "").lstrip().lower()
            if body_lc.startswith("<html") or "<html" in body_lc[:200]:
                print("[WARN] La respuesta parece HTML (no Atom XML). Revisa credenciales OPENMRS_USER/OPENMRS_PASS o permisos del endpoint.")

            return parsed
        print(f"[ERROR] Feed status: {r.status_code} | Body: {r.text}")
    except Exception as e:
        print(f"[ERROR] Al leer feed: {e}")
    return None


if __name__ == '__main__':
    print("🚀 Feed watcher iniciado.")
    if not FEED_URL:
        print("[ERROR] Falta ATOM_FEED_URL en variables de entorno.")
    if not OPENMRS_USER:
        print("[WARN] OPENMRS_USER no definido: se consultará el feed sin autenticación.")
    while True:
        print("\n🔁 Nueva iteración de polling...")
        feed = get_feed()
        if feed and getattr(feed, 'entries', None):
            process_feed(feed)
        else:
            print("[WARN] No se pudo procesar el feed o no hay entries.")
        time.sleep(FEED_POLL_INTERVAL)
