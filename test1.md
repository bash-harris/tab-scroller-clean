No. Don't start by testing through the extension.

You've just connected **4 separate systems**:

1. Chrome Extension UI
2. Background Service Worker
3. Django Backend
4. Ollama

If you test everything together first, you'll have no idea which component is broken.

Treat this like a backend engineer would and verify **one layer at a time**.

---

# Phase 1 — Verify Ollama Alone

This should take less than 2 minutes.

### Step 1

Run

```bash
ollama serve
```

Open another terminal

```bash
ollama list
```

You should see something like

```
NAME
qwen2.5:latest
nomic-embed-text:latest
```

If not

```bash
ollama pull qwen2.5
ollama pull nomic-embed-text
```

---

### Step 2

Test generation

```bash
ollama run qwen2.5
```

Ask

```
Return ONLY JSON.

{
"tool":"focus_tab",
"arguments":{"tabIds":[1]},
"message":"done"
}
```

If it starts explaining instead of returning JSON, your prompt needs improvement.

---

# Phase 2 — Verify Django Without Chrome

Don't touch Chrome yet.

Start Django

```
python manage.py runserver
```

---

### Test health

Open

```
http://localhost:8000/api/chat
```

If POST only

Expect

```
405 Method Not Allowed
```

Good.

---

### Test from Postman or Bruno

Send

POST

```
http://localhost:8000/api/chat
```

Body

```json
{
    "prompt":"group github tabs",
    "tabs":[
        {
            "id":1,
            "title":"GitHub - React",
            "url":"https://github.com/facebook/react"
        },
        {
            "id":2,
            "title":"Stack Overflow",
            "url":"https://stackoverflow.com"
        },
        {
            "id":3,
            "title":"GitHub Issues",
            "url":"https://github.com/issues"
        }
    ]
}
```

Expected

```json
{
    "success":true,
    "tool":"group_tabs",
    "arguments":{
        "tabIds":[1,3],
        "groupName":"GitHub",
        "color":"blue"
    }
}
```

If Django doesn't return exactly this structure

**Stop here.**

Do not test Chrome.

---

# Phase 3 — Verify ChatService

Now Chrome is still closed.

Open DevTools on the extension service worker.

Temporarily add

```javascript
ChatService.execute(...).then(console.log)
```

Expected

```javascript
{
    tool:"group_tabs",
    arguments:{
        tabIds:[1,3]
    }
}
```

If network request fails

Look at

Network

↓

Request

↓

Response

Do not continue.

---

# Phase 4 — Verify Background

Now test

WITHOUT content.js

Open

```
chrome://extensions
```

Developer Mode

↓

Inspect Service Worker

Now manually execute

```javascript
chrome.runtime.sendMessage({
    type:"AI_COMMAND",
    command:"group github tabs"
})
```

Watch console.

Expected

```
Received AI_COMMAND

↓

Fetched tabs

↓

Calling Django

↓

Received tool

↓

Executing group_tabs

↓

Success
```

No UI yet.

---

# Phase 5 — Verify TabService

Disable AI completely.

Hardcode

```javascript
const response={
    tool:"group_tabs",
    arguments:{
        tabIds:[12,14],
        groupName:"Github",
        color:"blue"
    }
}
```

Run

```javascript
TabService.groupTabs(...)
```

Did Chrome group?

If yes

TabService works.

---

# Phase 6 — Verify Full Pipeline

Only now test

```
> group github tabs
```

Watch

```
content.js
```

↓

```
background.js
```

↓

```
ChatService
```

↓

```
Django
```

↓

```
Ollama
```

↓

```
JSON
```

↓

```
TabService
```

↓

```
Chrome API
```

↓

```
Grouped
```

---

# Debugging Checklist

Whenever something breaks, ask:

### Did content.js send the message?

Console

```
Sending AI_COMMAND
```

If no

Problem in UI.

---

### Did background receive it?

```
Received AI_COMMAND
```

If no

Problem in messaging.

---

### Did ChatService send HTTP?

Network

```
POST /api/chat
```

If no

Problem in ChatService.

---

### Did Django receive request?

Run server

```
print(request.data)
```

Should show

```
prompt

tabs
```

If no

Problem in request serialization.

---

### Did Ollama return JSON?

Print raw response

```
print(raw_response)
```

Never parse immediately.

First inspect.

Many failures happen because the model wraps JSON like

```
Here's the JSON:

{
...
}
```

Your parser should catch this.

---

### Did Background execute correct tool?

Console

```
tool=group_tabs

tabIds=[1,4,8]
```

If wrong

Problem in backend prompt.

---

### Did Chrome API succeed?

Check

```
chrome.runtime.lastError
```

Always.

---

# Test Matrix

Run these commands one by one.

| User Command                | Expected Tool |
| --------------------------- | ------------- |
| group github tabs           | group_tabs    |
| close youtube tabs          | close_tabs    |
| pin amazon tabs             | pin_tabs      |
| bookmark documentation tabs | bookmark_tabs |
| switch to gmail             | focus_tab     |

Every one should:

```
Extension

↓

Django

↓

Ollama

↓

JSON

↓

Chrome Action
```

No exceptions.

---

# Before moving to Phase 2

You should be able to answer **YES** to all of these:

* ✅ Django works independently of Chrome.
* ✅ Ollama always returns valid JSON for your prompt.
* ✅ ChatService is only an HTTP client with no AI logic.
* ✅ `background.js` only orchestrates the flow and never reasons about commands.
* ✅ `TabService` is the only module calling Chrome APIs.
* ✅ Every natural-language command follows the same single path: **UI → Background → Django → Ollama → Tool → TabService → Browser**.

If any of those fail, fix that layer before adding semantic search, embeddings, or preview modals. A stable vertical slice is much easier to debug and extend than multiple partially working features.
t