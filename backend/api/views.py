import json
import os
import time
import requests
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "qwen2.5-coder:3b")
EMBEDDING_MODEL = "nomic-embed-text"

# Optional bearer/shared key. Unset = open (dev only). Set BACKEND_API_KEY in prod.
BACKEND_API_KEY = os.environ.get("BACKEND_API_KEY", "")

MAX_PROMPT_CHARS = 96 * 1024
MAX_NUM_PREDICT = 4096

VALID_TOOLS = {"group_tabs", "close_tabs", "focus_tab", "bookmark_tabs", "pin_tabs"}

SYSTEM_PROMPT = """You are a browser assistant. The extension has ALREADY selected the relevant tabs for the command. You ONLY decide which action to take and its parameters. NEVER return tab IDs.

Available tools:

group_tabs — Group the selected tabs together. Arguments: groupName (string), color (string: grey|blue|red|yellow|green|pink|purple|cyan|orange)
close_tabs — Close the selected tabs. Arguments: (none)
focus_tab — Switch to a tab. Arguments: (none — the best matching tab is selected automatically)
bookmark_tabs — Bookmark the selected tabs. Arguments: folderName (string)
pin_tabs — Pin/unpin the selected tabs. Arguments: pinned (bool: true to pin, false to unpin)

Return ONLY valid JSON. Never explain your reasoning. Never return markdown.

Response format:
{
  "tool": "tool_name",
  "arguments": { ... },
  "message": "Short description of what was done"
}"""


def call_ollama_generate(model, prompt, system_instruction=None, json_format=False):
    """Make a request to Ollama's /api/generate endpoint."""
    full_prompt = prompt
    if system_instruction:
        full_prompt = f"{system_instruction}\n\n{prompt}"

    body = {
        "model": model,
        "prompt": full_prompt,
        "stream": False,
        "options": {
            "temperature": 0.1
        }
    }

    if json_format:
        body["format"] = "json"

    t0 = time.time()
    response = requests.post(
        f"{OLLAMA_URL}/api/generate",
        headers={"Content-Type": "application/json"},
        json=body,
        timeout=120
    )
    t1 = time.time()
    print(f"[Timing] Ollama /api/generate: {(t1-t0)*1000:.0f}ms | model={model} | prompt_len={len(full_prompt)}")
    response.raise_for_status()
    return response.json()["response"]


def call_ollama_embeddings(model, text):
    """Make a request to Ollama's /api/embeddings endpoint."""
    body = {
        "model": model,
        "prompt": text
    }

    t0 = time.time()
    response = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        headers={"Content-Type": "application/json"},
        json=body,
        timeout=30
    )
    t1 = time.time()
    print(f"[Timing] Ollama /api/embeddings: {(t1-t0)*1000:.0f}ms | text_len={len(text)}")

    if not response.ok:
        raise Exception(f"Ollama API Error: {response.text}")

    data = response.json()
    return data["embedding"]


def build_prompt(user_command, tabs):
    """Build the prompt sent to Ollama with command and tab metadata."""
    tab_lines = []
    for tab in tabs:
        score = tab.get('score', '')
        score_str = f" [score={score}]" if score else ""
        tab_lines.append(
            f"{tab['id']} | {tab.get('title', 'Untitled')} | {tab.get('url', '')}{score_str}"
        )
    tab_list = "\n".join(tab_lines)

    return f"""Command: {user_command}

The extension has pre-selected these tabs as the relevant candidates (ranked by relevance score):
{tab_list}

Choose the appropriate tool and its parameters for these tabs. Do NOT include tab IDs in your response."""


def validate_tool_response(data):
    """Validate that the LLM response contains required fields with valid values."""
    if not isinstance(data, dict):
        return False, "Response is not a JSON object"

    tool = data.get("tool")
    if tool not in VALID_TOOLS:
        return False, f"Invalid tool: {tool}"

    arguments = data.get("arguments")
    if not isinstance(arguments, dict):
        return False, "Arguments must be a JSON object"

    message = data.get("message", "")
    if not isinstance(message, str):
        return False, "Message must be a string"

    return True, None


def require_auth(request):
    """Return an error JsonResponse if auth fails, else None."""
    if not BACKEND_API_KEY:
        return None
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        token = header[len("Bearer "):]
    else:
        token = request.headers.get("X-Api-Key", "")
    if token == BACKEND_API_KEY:
        return None
    return JsonResponse({"error": "Unauthorized"}, status=401)


@csrf_exempt
def generate(request):
    """Ollama-compatible /api/generate gateway.

    The extension posts exactly what it sends to Ollama's /api/generate
    (model, prompt, stream:false, format, keep_alive, options{temperature,
    num_predict, num_ctx}) — this endpoint validates, proxies to the local
    LLM (Ollama by default), and returns the same response shape:
    {model, response, prompt_eval_count, eval_count}.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    auth_err = require_auth(request)
    if auth_err:
        return auth_err

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    prompt = body.get('prompt')
    if not prompt or not isinstance(prompt, str):
        return JsonResponse({'error': 'Missing required field: prompt'}, status=400)
    if len(prompt) > MAX_PROMPT_CHARS:
        return JsonResponse({'error': f'Prompt too large (max {MAX_PROMPT_CHARS} chars)'}, status=400)

    if body.get('stream'):
        return JsonResponse({'error': 'Streaming not supported; set stream:false'}, status=400)

    model = body.get('model') or DEFAULT_MODEL
    options = body.get('options') or {}
    temperature = options.get('temperature', 0.1)
    num_predict = min(int(options.get('num_predict', 2048) or 2048), MAX_NUM_PREDICT)
    num_ctx = min(int(options.get('num_ctx', 8192) or 8192), 32768)
    json_format = body.get('format') == 'json'

    try:
        t0 = time.time()
        ollama_body = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": body.get('keep_alive', -1),
            "options": {
                "temperature": float(temperature),
                "num_predict": num_predict,
                "num_ctx": num_ctx
            }
        }
        if json_format:
            ollama_body["format"] = "json"

        response = requests.post(
            f"{OLLAMA_URL}/api/generate",
            headers={"Content-Type": "application/json"},
            json=ollama_body,
            timeout=180
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        print(f"[Timing] Django /api/generate: {elapsed_ms}ms | model={model} | prompt_len={len(prompt)} | num_predict={num_predict}")

        if not response.ok:
            return JsonResponse({
                'error': f'Upstream LLM error: HTTP {response.status_code}: {response.text[:500]}'
            }, status=502)

        data = response.json()
        return JsonResponse({
            'model': data.get('model', model),
            'response': data.get('response', ''),
            'prompt_eval_count': data.get('prompt_eval_count', 0),
            'eval_count': data.get('eval_count', 0),
            'done': True
        })
    except requests.exceptions.ConnectionError:
        return JsonResponse({'error': 'LLM server is offline'}, status=502)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
def chat(request):
    """Phase 1: Send command + tabs to Ollama, return structured tool call."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    prompt = body.get('prompt')
    tabs = body.get('tabs')

    if not prompt:
        return JsonResponse({'error': 'Missing required field: prompt'}, status=400)

    if not tabs or not isinstance(tabs, list):
        return JsonResponse({'error': 'Missing required field: tabs (must be a list)'}, status=400)

    model = body.get('model', DEFAULT_MODEL)

    try:
        t_start = time.time()
        full_prompt = build_prompt(prompt, tabs)
        t_prompt = time.time()
        print(f"[Timing] build_prompt: {(t_prompt - t_start)*1000:.0f}ms | {len(tabs)} tabs")

        text_response = call_ollama_generate(
            model=model,
            prompt=full_prompt,
            system_instruction=SYSTEM_PROMPT,
            json_format=True
        )
        t_llm = time.time()
        print(f"[Timing] call_ollama_generate: {(t_llm - t_prompt)*1000:.0f}ms | model={model}")

        try:
            llm_data = json.loads(text_response)
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Model returned invalid JSON'}, status=500)

        valid, err_msg = validate_tool_response(llm_data)
        if not valid:
            return JsonResponse({'error': f'Invalid model response: {err_msg}'}, status=500)

        print(f"[Timing] TOTAL Django: {(time.time() - t_start)*1000:.0f}ms | tool={llm_data.get('tool')}")

        return JsonResponse({
            'tool': llm_data.get('tool'),
            'arguments': llm_data.get('arguments', {}),
            'message': llm_data.get('message', ''),
        })

    except requests.exceptions.ConnectionError:
        return JsonResponse({'error': 'AI server is offline'}, status=500)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
def summarize(request):
    """Endpoint to generate summary for website text."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    text = body.get('text', '')
    if not text:
        return JsonResponse({'summary': ''})

    prompt = f"Summarize the following webpage content in 1-2 sentence(s):\n\n{text[:4000]}"

    try:
        summary_text = call_ollama_generate(
            model=DEFAULT_MODEL,
            prompt=prompt,
            system_instruction="You are a helpful assistant that generates extremely concise, accurate summaries of page content."
        )
        return JsonResponse({'summary': summary_text.strip()})
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
def embeddings(request):
    """Endpoint to generate vector embedding for a given text query/document."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    text = body.get('text', '')
    if not text:
        return JsonResponse({'embedding': []})

    try:
        t0 = time.time()
        emb = call_ollama_embeddings(EMBEDDING_MODEL, text)
        t1 = time.time()
        print(f"[Timing] Django /api/embeddings: {(t1-t0)*1000:.0f}ms | text_len={len(text)} | emb_len={len(emb) if emb else 0}")
        return JsonResponse({'embedding': emb})
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


# ============================================================================
# PERSISTENT TAB STORAGE & HIGH-THROUGHPUT SEARCH ENDPOINTS
# ============================================================================
from .models import TabCard, TabEntity, EntityResolutionCache, setup_fts_tables
from django.db import connection, transaction
from django.utils import timezone


@csrf_exempt
def sync_tabs(request):
    """Bulk upsert tab cards + embeddings into persistent SQLite storage."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    tabs = body.get('tabs', [])
    if not isinstance(tabs, list):
        return JsonResponse({'error': 'tabs must be a list'}, status=400)

    if not tabs:
        return JsonResponse({'success': True, 'synced': 0, 'total': TabCard.objects.count()})

    synced_count = 0
    t0 = time.time()
    setup_fts_tables()

    with transaction.atomic():
        for t in tabs:
            url_hash = t.get('urlHash') or t.get('url_hash')
            if not url_hash:
                continue

            card, created = TabCard.objects.update_or_create(
                url_hash=url_hash,
                defaults={
                    'url': t.get('url', ''),
                    'title': t.get('title', ''),
                    'domain': t.get('domain', ''),
                    'category': t.get('category', ''),
                    'tags': t.get('tags', []),
                    'keywords': t.get('keywords', []),
                    'pseudo_doc': t.get('pseudoDoc', t.get('pseudo_doc', '')),
                    'main_text': t.get('mainText', t.get('main_text', '')),
                    'embedding': t.get('embedding'),
                    'extraction_tier': t.get('extractionTier', t.get('extraction_tier', 'local_ner')),
                    'last_seen_open_at': timezone.now(),
                }
            )

            # Process optional entities linked to this tab
            entities = t.get('entities', [])
            if isinstance(entities, list) and entities:
                TabEntity.objects.filter(url_hash=card).delete()
                entity_objs = [
                    TabEntity(
                        url_hash=card,
                        entity_name=e.get('name', '').strip().lower(),
                        entity_type=e.get('type', 'general').strip().lower(),
                        confidence=float(e.get('confidence', 1.0))
                    )
                    for e in entities
                    if e.get('name')
                ]
                if entity_objs:
                    TabEntity.objects.bulk_create(entity_objs, ignore_conflicts=True)

            synced_count += 1

    t1 = time.time()
    total_cards = TabCard.objects.count()
    print(f"[Timing] sync_tabs: {(t1-t0)*1000:.1f}ms | synced {synced_count} tabs | total in DB: {total_cards}")

    return JsonResponse({
        'success': True,
        'synced': synced_count,
        'total': total_cards
    })


@csrf_exempt
def get_cards(request):
    """Retrieve all stored cards or a subset by url_hash."""
    hashes_param = request.GET.get('hashes')
    if hashes_param:
        hash_list = [h.strip() for h in hashes_param.split(',') if h.strip()]
        cards = TabCard.objects.filter(url_hash__in=hash_list)
    else:
        limit = min(int(request.GET.get('limit', 2000)), 5000)
        cards = TabCard.objects.all()[:limit]

    return JsonResponse({
        'cards': [c.to_dict() for c in cards],
        'total': TabCard.objects.count()
    })


@csrf_exempt
def fts_search(request):
    """Sub-10ms Full-Text Search on SQLite FTS5 table."""
    query = request.GET.get('q', '').strip()
    if not query:
        return JsonResponse({'results': [], 'total': 0})

    limit = min(int(request.GET.get('limit', 50)), 200)
    t0 = time.time()

    # Sanitize FTS5 query terms (remove syntax characters that break FTS parser)
    safe_terms = []
    for t in query.split():
        clean_t = t.replace('"', '').replace("'", '').replace('*', '')
        if clean_t.isalnum() or len(clean_t) > 1:
            safe_terms.append(f'"{clean_t}"')

    if not safe_terms:
        return JsonResponse({'results': [], 'total': 0})

    fts_query = ' OR '.join(safe_terms)

    setup_fts_tables()

    results = []
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT c.url_hash, c.url, c.title, c.domain, c.category, c.tags, c.keywords, c.pseudo_doc, fts.rank
            FROM tab_fts fts
            JOIN tab_cards c ON fts.url_hash = c.url_hash
            WHERE tab_fts MATCH %s
            ORDER BY fts.rank
            LIMIT %s
        """, [fts_query, limit])

        rows = cursor.fetchall()
        for row in rows:
            results.append({
                'urlHash': row[0],
                'url': row[1],
                'title': row[2],
                'domain': row[3],
                'category': row[4],
                'tags': json.loads(row[5]) if isinstance(row[5], str) else row[5],
                'keywords': json.loads(row[6]) if isinstance(row[6], str) else row[6],
                'pseudoDoc': row[7],
                'score': round(abs(float(row[8])), 4)
            })

    t1 = time.time()
    print(f"[Timing] fts_search: {(t1-t0)*1000:.1f}ms | query='{query}' | matches={len(results)}")

    return JsonResponse({
        'query': query,
        'results': results,
        'count': len(results)
    })


@csrf_exempt
def entity_query(request):
    """Find tabs matching a list of named entities in SQLite."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    entity_names = [str(e).strip().lower() for e in body.get('entities', []) if str(e).strip()]
    if not entity_names:
        return JsonResponse({'matches': []})

    t0 = time.time()
    matches = []
    with connection.cursor() as cursor:
        placeholders = ', '.join(['%s'] * len(entity_names))
        cursor.execute(f"""
            SELECT c.url_hash, c.url, c.title, c.domain, c.category, e.entity_name, e.entity_type, e.confidence
            FROM tab_entities e
            JOIN tab_cards c ON e.url_hash = c.url_hash
            WHERE e.entity_name IN ({placeholders})
            ORDER BY e.confidence DESC
            LIMIT 100
        """, entity_names)

        rows = cursor.fetchall()
        for row in rows:
            matches.append({
                'urlHash': row[0],
                'url': row[1],
                'title': row[2],
                'domain': row[3],
                'category': row[4],
                'matchedEntity': row[5],
                'entityType': row[6],
                'confidence': float(row[7])
            })

    t1 = time.time()
    print(f"[Timing] entity_query: {(t1-t0)*1000:.1f}ms | entities={entity_names} | matches={len(matches)}")
    return JsonResponse({'matches': matches, 'count': len(matches)})


@csrf_exempt
def resolve_multi_hop(request):
    """Decompose complex queries into canonical entities with 30-day SQLite caching."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    query = body.get('query', '').strip()
    if not query:
        return JsonResponse({'entities': [], 'cached': False})

    # Canonicalize key
    canonical_key = query.lower().replace(' ', '_')[:250]

    # Check cache
    try:
        cache_entry = EntityResolutionCache.objects.get(query_key=canonical_key)
        if not cache_entry.is_expired():
            return JsonResponse({
                'queryKey': canonical_key,
                'resolvedEntities': cache_entry.resolved_entities,
                'cached': True
            })
    except EntityResolutionCache.DoesNotExist:
        pass

    # Cache miss: Decompose with local LLM
    prompt = f"""Extract and expand all implicit real-world named entities (people, actors, titles, awards, technologies) needed to answer this query:
User Query: "{query}"

Return ONLY a JSON list of entity strings. Example: ["Philip Seymour Hoffman", "Reese Witherspoon", "George Clooney"]"""

    resolved_entities = []
    try:
        llm_out = call_ollama_generate(
            model=DEFAULT_MODEL,
            prompt=prompt,
            system_instruction="You are a knowledge graph entity resolver. Return ONLY valid JSON array of strings.",
            json_format=True
        )
        parsed = json.loads(llm_out)
        if isinstance(parsed, list):
            resolved_entities = [str(x).strip() for x in parsed if str(x).strip()]
        elif isinstance(parsed, dict) and 'entities' in parsed:
            resolved_entities = [str(x).strip() for x in parsed['entities'] if str(x).strip()]
    except Exception as e:
        print(f"[MultiHop] LLM entity resolution fallback: {e}")
        # Fallback: extract basic capitalized/quoted entities from the query itself
        import re
        resolved_entities = re.findall(r'\b[A-Z][a-z0-9_]+\b', query)

    # Save to SQLite resolution cache
    EntityResolutionCache.objects.update_or_create(
        query_key=canonical_key,
        defaults={
            'resolved_entities': resolved_entities,
            'resolved_at': timezone.now(),
        }
    )

    return JsonResponse({
        'queryKey': canonical_key,
        'resolvedEntities': resolved_entities,
        'cached': False
    })


@csrf_exempt
def get_stats(request):
    """Retrieve database telemetry and coverage statistics."""
    total_cards = TabCard.objects.count()
    total_entities = TabEntity.objects.count()
    cached_queries = EntityResolutionCache.objects.count()

    return JsonResponse({
        'totalCards': total_cards,
        'totalEntities': total_entities,
        'cachedResolutions': cached_queries,
        'ftsReady': True,
        'timestamp': timezone.now().isoformat()
    })


@csrf_exempt
def delete_tabs(request):
    """Prune tabs by url_hash from SQLite database."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    hashes = body.get('hashes', [])
    if isinstance(hashes, list) and hashes:
        matching_cards = TabCard.objects.filter(url_hash__in=hashes)
        deleted_count = matching_cards.count()
        matching_cards.delete()
        return JsonResponse({'success': True, 'deleted': deleted_count})

    return JsonResponse({'success': True, 'deleted': 0})

