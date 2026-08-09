import urllib.request
import json
import traceback

try:
    req = urllib.request.Request(
        'http://localhost:11434/api/embed',
        data=json.dumps({'model': 'qwen2.5', 'input': 'test'}).encode(),
        headers={'Content-Type': 'application/json'}
    )
    res = urllib.request.urlopen(req)
    data = res.read().decode()
    with open('ollama_test.txt', 'w') as f:
        f.write(data)
except Exception as e:
    with open('ollama_test_error.txt', 'w') as f:
        traceback.print_exc(file=f)
        if hasattr(e, 'read'):
            f.write("\n\n" + e.read().decode())
