"""Phase 1, Step 2: Verify Ollama returns valid JSON for the system prompt."""
import requests
import json
import re

OLLAMA_URL = "http://localhost:11434"

SYSTEM_PROMPT = (
    "You are a browser assistant. Choose exactly one tool.\n\n"
    "Available tools:\n\n"
    "group_tabs - Group tabs together. Arguments: tabIds (list of int), groupName (string), color (string)\n"
    "close_tabs - Close tabs. Arguments: tabIds (list of int)\n"
    "focus_tab - Switch to a tab. Arguments: tabId (int)\n"
    "bookmark_tabs - Bookmark tabs. Arguments: tabIds (list of int), folderName (string)\n"
    "pin_tabs - Pin tabs. Arguments: tabIds (list of int), pinned (bool)\n\n"
    "Return ONLY valid JSON. Never explain your reasoning. Never return markdown.\n\n"
    'Response format:\n{"tool":"tool_name","arguments":{...},"message":"Short description"}'
)

TEST_CASES = [
    {
        "name": "group github tabs",
        "prompt": (
            "Command: group all github tabs\n\n"
            "Available Tabs:\n"
            "1 | GitHub - React | https://github.com/facebook/react\n"
            "2 | Stack Overflow | https://stackoverflow.com\n"
            "3 | GitHub Issues | https://github.com/issues"
        ),
        "expected_tool": "group_tabs",
    },
    {
        "name": "close youtube tabs",
        "prompt": (
            "Command: close youtube tabs\n\n"
            "Available Tabs:\n"
            "1 | YouTube - Video | https://youtube.com/watch?v=abc\n"
            "2 | GitHub | https://github.com\n"
            "3 | YouTube Music | https://music.youtube.com"
        ),
        "expected_tool": "close_tabs",
    },
    {
        "name": "pin amazon tabs",
        "prompt": (
            "Command: pin amazon tabs\n\n"
            "Available Tabs:\n"
            "1 | Amazon Shopping | https://amazon.com/dp/123\n"
            "2 | GitHub | https://github.com"
        ),
        "expected_tool": "pin_tabs",
    },
    {
        "name": "bookmark documentation tabs",
        "prompt": (
            "Command: bookmark documentation tabs\n\n"
            "Available Tabs:\n"
            "1 | React Docs | https://react.dev\n"
            "2 | MDN Web Docs | https://developer.mozilla.org\n"
            "3 | GitHub | https://github.com"
        ),
        "expected_tool": "bookmark_tabs",
    },
    {
        "name": "switch to gmail",
        "prompt": (
            "Command: switch to gmail\n\n"
            "Available Tabs:\n"
            "1 | Gmail - Inbox | https://mail.google.com\n"
            "2 | GitHub | https://github.com"
        ),
        "expected_tool": "focus_tab",
    },
]

VALID_TOOLS = {"group_tabs", "close_tabs", "focus_tab", "bookmark_tabs", "pin_tabs"}

passed = 0
failed = 0

for tc in TEST_CASES:
    print(f"\n--- {tc['name']} ---")
    full_prompt = f"{SYSTEM_PROMPT}\n\n{tc['prompt']}"

    body = {
        "model": "qwen2.5",
        "prompt": full_prompt,
        "stream": False,
        "options": {"temperature": 0.1},
        "format": "json",
    }

    try:
        resp = requests.post(f"{OLLAMA_URL}/api/generate", json=body, timeout=120)
        resp.raise_for_status()
        raw = resp.json()["response"]
        print(f"Raw: {raw[:200]}")

        # Try direct parse
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # Strip markdown code blocks
            cleaned = re.sub(r"```json\s*", "", raw)
            cleaned = re.sub(r"```\s*$", "", cleaned)
            cleaned = cleaned.strip()
            data = json.loads(cleaned)

        # Validate
        assert "tool" in data, f"Missing 'tool' field"
        assert data["tool"] in VALID_TOOLS, f"Invalid tool: {data['tool']}"
        assert "arguments" in data, f"Missing 'arguments' field"
        assert isinstance(data["arguments"], dict), f"Arguments not a dict"
        assert data["tool"] == tc["expected_tool"], f"Wrong tool: {data['tool']} != {tc['expected_tool']}"

        print(f"PASS: tool={data['tool']}, arguments={json.dumps(data['arguments'])}")
        passed += 1
    except Exception as e:
        print(f"FAIL: {e}")
        failed += 1

print(f"\n{'='*50}")
print(f"Results: {passed} passed, {failed} failed out of {len(TEST_CASES)}")
