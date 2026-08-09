# Tab Scroller v2 — Goal Document

> Complete user-facing feature specification for the full rebuild.
> Target user: Power user / developer with 50-300+ tabs.
> Core problem: Tab organization.
> Interaction model: AI-suggested + user confirms.

---

## 1. Enhanced Tab Strip

### 1.1 Overview
A horizontal tab strip that replaces Chrome's native tab bar behavior. Renders as an overlay at the top of the viewport using Shadow DOM. Premium, dark-first design with smooth animations.

### 1.2 Visual Design
- **Dark theme** with subtle glass-morphism (backdrop-blur, semi-transparent backgrounds)
- **No page push** — strip floats over page content, does NOT shift the page down
- Strip is **fixed at the top** of the viewport, always accessible
- **Thin collapsed state** (2-4px bar) when not hovered, expands to full strip on hover
- Smooth **slide-down animation** (200-300ms ease-out) on hover
- **Click-to-lock**: clicking the collapsed bar pins the strip open; clicking again or pressing Escape collapses
- Consistent appearance across ALL tabs (same CSS, same state)

### 1.3 Tab Rendering
Each tab in the strip shows:
- **Favicon** (16x16, with fallback to first letter of title)
- **Title** (truncated with ellipsis, max ~150px width)
- **Close button** (× icon, appears on hover of individual tab)
- **Group color indicator** (small colored dot or left-border accent if tab belongs to a group)
- **Pinned indicator** (pin icon overlay on favicon if pinned)
- **Muted indicator** (muted speaker icon if muted)
- **Loading indicator** (spinner if tab is still loading)

### 1.4 Tab Groups
- Groups appear as **section dividers** in the strip with group name + color
- Group label is clickable (selects all tabs in group)
- Collapse/expand group by clicking the label
- Group color matches Chrome's native group colors (grey, blue, red, yellow, green, pink, purple, cyan, orange)

### 1.5 Interactions
- **Hover** on collapsed strip → expand with animation
- **Hover** on individual tab → show close button, highlight background
- **Click** on tab → focus that tab (switch to it)
- **Middle-click** on tab → close that tab
- **Right-click** on tab → context menu (close, close others, close to right, pin, mute, bookmark, move to group, move to window)
- **Drag-and-drop** → reorder tabs within strip, move between groups
- **Scroll** → horizontal scroll when tabs overflow (scroll wheel or trackpad)
- **Keyboard**: Left/Right arrows navigate tabs, Enter focuses, Delete closes

### 1.6 Controls in Strip
Left side:
- **Center button** (⊙) — scroll active tab into view
- **Pin button** (📌) — toggle always-show / auto-hide

Right side:
- **AI Chat button** (🤖) — opens AI chat sidebar
- **Search button** (🔍) — opens inline search
- **Undo button** (↩️) — appears after destructive actions, auto-hides after 15s

Removed from v1 (no longer in strip):
- ~~Magic button (🪄)~~
- ~~Declutter button (✨)~~
- ~~Shield button (🛡️)~~
- ~~Bookmark button (🔖)~~
- ~~Session button (📋)~~
- ~~Sort select dropdown~~
- ~~Cleanup button (🧹)~~

---

## 2. AI Chat Sidebar

### 2.1 Overview
A persistent sidebar panel on the right side of the viewport. Chat-like interface for issuing natural language commands to manage tabs. Opens via keyboard shortcut or button click.

### 2.2 Opening/Closing
- **Keyboard shortcut**: `Ctrl+Shift+G` (configurable)
- **Button**: 🤖 icon in tab strip
- **Toggle**: same shortcut or button closes if open
- Sidebar slides in from the right with animation
- Focus automatically moves to input field when opened

### 2.3 Layout
```
┌─────────────────────────────┐
│  Tab Scroller AI        [×] │  ← header with close button
├─────────────────────────────┤
│                             │
│  User: group my github tabs │  ← message history (scrollable)
│                             │
│  AI: Found 12 GitHub tabs.  │
│  ┌───────────────────────┐  │
│  │ ☑ github.com/repo1    │  │  ← preview card with checkboxes
│  │ ☑ github.com/repo2    │  │
│  │ ☑ docs.github.com     │  │
│  │ ...                    │  │
│  │                        │  │
│  │ Group name: [GitHub ]  │  │  ← editable group name
│  │ Color: [blue ▾]        │  │  ← color picker
│  │                        │  │
│  │ [Cancel]  [Confirm(12)]│  │  ← action buttons
│  └───────────────────────┘  │
│                             │
├─────────────────────────────┤
│ 📎 [Ask AI anything...  ]  │  ← input field
└─────────────────────────────┘
```

### 2.4 Message Types
- **User messages**:显示用户输入的命令
- **AI responses**: text explanation + action preview card (if action needed)
- **System messages**: errors, confirmations ("Grouped 12 tabs into GitHub")
- **Action cards**: interactive preview with checkboxes, editable parameters, confirm/cancel

### 2.5 Action Preview Cards
When AI suggests an action, show a card with:
- **Action title**: "Group Tabs", "Close Tabs", etc.
- **Affected tabs list**: each tab with checkbox (default: all checked)
- **Editable parameters**: group name, folder name, pinned state, etc.
- **Confidence indicator**: high/medium/low based on retrieval score
- **Path indicator**: "deterministic" (fast, no LLM) vs "semantic" (AI-analyzed)
- **Confirm button**: shows count of selected tabs
- **Cancel button**: dismisses the action

### 2.6 Conversation Features
- **History persists** within browser session (cleared on browser restart)
- **Scroll independently** from tab strip
- **Copy message** via right-click or button
- **Clear history** via header button
- **Quick actions bar** above input:
  - "Group All" — groups all tabs by domain
  - "Clean Up" — suggests cleanup actions
  - "Save Session" — saves current state
  - "Find Duplicates" — scans for duplicate tabs

### 2.7 Streaming Responses
- AI responses stream in real-time (character by character as LLM generates)
- Loading indicator while waiting for first token
- Cancel button during streaming to abort

### 2.8 Error Handling
- If backend is offline: show "AI server offline" with retry button
- If command fails: show error with explanation and suggest alternatives
- If no tabs match: "No matching tabs found" with suggestions

---

## 3. Smart Grouping

### 3.1 Overview
AI-powered tab grouping that understands tab CONTENT and BROWSING SESSION context. Goes beyond simple domain matching to understand what tabs are about.

### 3.2 Content-Aware Grouping
Reads tab page content (via `chrome.scripting.executeScript` → `innerText`) to understand what each tab is about.

**Example commands:**
- "Group tabs about my deployment pipeline" → reads content, finds CI/CD, GitHub Actions, Jenkins, etc.
- "Group tabs related to React hooks" → finds React docs, Stack Overflow answers, blog posts about hooks
- "Group tabs about machine learning" → groups ML papers, tutorials, library docs regardless of domain
- "Group tabs for project X" → combines URL patterns + content analysis to find project-related tabs

**How it works:**
1. Extract text content from each tab (first 3000 chars of body.innerText)
2. Generate embedding for each tab's content (title + URL + extracted text)
3. Generate embedding for the user's query
4. Cosine similarity search to find matching tabs
5. Cluster results by topic similarity
6. Present grouped results to user for confirmation

### 3.3 Session-Aware Grouping
Uses browsing history patterns and temporal signals to group tabs.

**Example commands:**
- "Group tabs I opened while working on feature X" → correlates by time window + domain patterns
- "Group my morning research tabs" → time-based grouping (tabs opened 6am-9am)
- "Group tabs from this week" → recency-based grouping
- "Group tabs I opened after reading that article" → sequential browsing pattern

**How it works:**
1. Query `chrome.history` for recently visited URLs
2. Correlate tab open times with browsing patterns
3. Identify clusters of related browsing sessions
4. Group by temporal proximity + domain diversity

### 3.4 Multi-Hop Queries
Complex queries that combine multiple signals:

- "Group tabs I need for tomorrow's presentation" → content analysis (presentation-related) + recency (recently opened) + domain clustering (slides, docs, images)
- "Group tabs related to the bug I'm debugging" → content analysis (error messages, stack traces) + domain patterns (GitHub issues, Stack Overflow)
- "Group tabs from my side project" → domain patterns (specific repos) + content analysis (project name mentions)

### 3.5 Deterministic Fast Path (Preserved)
Simple domain-based commands still skip the LLM entirely:
- "group github tabs" → domain match, ~6ms
- "close reddit tabs" → domain match, ~6ms
- "bookmark youtube tabs" → domain match, ~6ms

### 3.6 Grouping UX Flow
1. User types command in chat sidebar
2. AI analyzes tabs (deterministic or semantic path)
3. Preview card shows proposed groups with tab checkboxes
4. User can:
   - Uncheck tabs to exclude from grouping
   - Edit group names
   - Change group colors
   - Split into multiple groups
   - Cancel entirely
5. User confirms → tabs are grouped
6. Toast notification: "Grouped 12 tabs into 'GitHub'"

---

## 4. Session Save & Restore

### 4.1 Overview
Save the current state of all tabs (URLs, groups, pinned status, positions) as a named session. Restore sessions later to reopen the exact same tab configuration.

### 4.2 Saving Sessions
- **Manual save**: via chat command "save session" or quick action button
- **Auto-save**: optionally auto-save when browser closes (configurable in settings)
- **Session data**:
  - Session name (user-provided or auto-generated from timestamp + tab count)
  - Timestamp
  - List of tabs: URL, title, pinned status, muted status, group name, group color, position
  - Metadata: total tab count, domain summary, source browser info

### 4.3 Session Management UI
Access via chat command "show sessions" or dedicated button:
- **Session list**: all saved sessions with name, timestamp, tab count, preview
- **Session preview**: expand to see tab list with favicons
- **Restore**: click to restore entire session
- **Export**: download session as JSON file
- **Delete**: remove session from storage
- **Rename**: edit session name

### 4.4 Restoring Sessions
- Opens all tabs from the saved session
- Recreates tab groups with same names and colors
- Restores pinned/muted status
- Option to restore in current window or new window
- Option to merge with existing tabs or replace

### 4.5 Storage
- Sessions stored in IndexedDB (same database as tab cards)
- Schema:
  ```
  {
    id: string (uuid),
    name: string,
    createdAt: number (timestamp),
    updatedAt: number (timestamp),
    tabs: [{
      url: string,
      title: string,
      pinned: boolean,
      muted: boolean,
      group: { name: string, color: string } | null,
      index: number
    }],
    metadata: {
      tabCount: number,
      domains: string[],
      source: string
    }
  }
  ```

---

## 5. Cross-Browser Portability (Export/Import)

### 5.1 Overview
Export sessions as JSON files that can be imported into the extension on any Chromium-based browser (Chrome, Edge, Brave, Vivaldi).

### 5.2 Export Format
Open, documented JSON format:
```json
{
  "format": "tab-scroller-session",
  "version": "2.0",
  "exportedAt": "2026-07-18T10:30:00Z",
  "session": {
    "name": "Research Session",
    "tabs": [
      {
        "url": "https://github.com/user/repo",
        "title": "User/repo - GitHub",
        "pinned": false,
        "muted": false,
        "group": { "name": "GitHub", "color": "blue" }
      }
    ],
    "metadata": {
      "tabCount": 15,
      "domains": ["github.com", "stackoverflow.com"],
      "browser": "Chrome",
      "extensionVersion": "2.0.0"
    }
  }
}
```

### 5.3 Export Actions
- **Export single session**: download as `.json` file
- **Export current state**: save all open tabs as a new session, then export
- **Bulk export**: export all saved sessions as a single JSON array

### 5.4 Import Actions
- **Import session**: select `.json` file → recreate tabs
- **Import options**:
  - Open in current window or new window
  - Merge with existing tabs or replace
  - Skip duplicate URLs or create duplicates
  - Preserve groups or flatten
- **Validation**: check JSON format, warn about incompatible URLs

### 5.5 Sharing
- Export file can be shared via any means (email, chat, file sharing)
- Recipient imports file into their browser's extension
- No account required, no cloud dependency

---

## 6. Natural Language Tab Operations

### 6.1 Overview
All tab operations available via natural language in the chat sidebar. The AI interprets the command, suggests an action, and the user confirms.

### 6.2 Supported Operations
| Operation | Example Commands | Action |
|-----------|-----------------|--------|
| **Close** | "close all reddit tabs", "close these tabs", "close everything except github" | `chrome.tabs.remove()` |
| **Pin/Unpin** | "pin these tabs", "unpin all pinned tabs" | `chrome.tabs.update({ pinned })` |
| **Mute/Unmute** | "mute all tabs", "unmute this tab" | `chrome.tabs.update({ muted })` |
| **Focus** | "switch to github", "open the docs tab" | `chrome.tabs.update({ active: true })` |
| **Group** | "group all github tabs", "group these by topic" | `chrome.tabs.group()` + `chrome.tabGroups.update()` |
| **Ungroup** | "ungroup all tabs", "remove this group" | `chrome.tabs.ungroup()` |
| **Bookmark** | "bookmark these tabs", "save to research folder" | `chrome.bookmarks.create()` |
| **Move** | "move these to new window", "move to window 2" | `chrome.tabs.move()` |
| **Reload** | "reload all tabs", "refresh this tab" | `chrome.tabs.reload()` |
| **Duplicate** | "duplicate this tab" | `chrome.tabs.duplicate()` |
| **Arrange** | "sort tabs by domain", "sort by title" | Reorder tabs in strip |

### 6.3 Confirmation Flow
1. User types command
2. AI parses intent → determines action + parameters
3. If destructive (close, ungroup): **always show preview** with confirmation
4. If non-destructive (group, bookmark, pin): show preview, allow quick confirm
5. User confirms → execute → show result toast
6. Undo button appears for 15 seconds after destructive actions

### 6.4 Undo System
- Track last action in memory (tab IDs, action type, previous state)
- Undo restores previous state:
  - Closed tabs → reopen them (if possible, within session)
  - Grouped tabs → ungroup them
  - Pinned tabs → unpin them
  - Muted tabs → unmute them
- Undo available for 15 seconds after action
- Undo button in tab strip + "Undo" text command in chat

---

## 7. Tab Cleanup & Deduplication

### 7.1 Overview
Detect and clean up duplicate, stale, and unnecessary tabs.

### 7.2 Duplicate Detection
- **Exact duplicates**: same URL (case-insensitive, ignoring trailing slash)
- **Near duplicates**: same domain + similar title (fuzzy match)
- **AI-detected duplicates**: content analysis shows same topic (e.g., two different articles about the same thing)

### 7.3 Stale Tab Detection
- Tabs not accessed in X days (configurable, default: 7 days)
- Uses `chrome.history` to check last access time
- Tabs in groups that haven't been accessed recently

### 7.4 Cleanup Suggestions
AI analyzes tab set and suggests:
- "You have 5 GitHub tabs open — group them?"
- "These 3 tabs have the same content — close duplicates?"
- "These 10 tabs haven't been accessed in 2 weeks — archive or close?"
- "You have 200+ tabs open — here are the groups I found"

### 7.5 Cleanup Actions
- **Close duplicates**: keep most recent/active, close others
- **Close stale**: close tabs not accessed in X days
- **Group uncategorized**: group tabs that aren't in any group
- **Bookmark and close**: save URLs as bookmark, then close tabs

---

## 8. Search & Discovery

### 8.1 Overview
Fuzzy search across all open tabs by title, URL, and content.

### 8.2 Search UI
- Activated by search button (🔍) in tab strip or `Ctrl+F` (when strip is focused)
- Inline search bar appears in the tab strip
- Results filter the strip in real-time
- Results show with highlighted matching text

### 8.3 Search Capabilities
- **Title search**: match against tab titles
- **URL search**: match against tab URLs
- **Content search**: match against extracted page content (if indexed)
- **Fuzzy matching**: tolerate typos, partial matches
- **Domain filter**: "site:github.com" syntax

### 8.4 Search Results
- Matching tabs highlighted in strip
- Non-matching tabs dimmed or hidden
- Arrow keys navigate results
- Enter focuses selected tab
- Escape clears search and restores full strip

---

## 9. Content Extraction & Indexing

### 9.1 Overview
Background indexing of tab content for AI-powered features.

### 9.2 What Gets Indexed
- Tab URL, title, favicon
- Page content (first 3000 chars of `innerText`)
- Extracted keywords (stop-word removed, stemmed)
- Domain
- Timestamps (created, last updated, last accessed)

### 9.3 When Indexing Happens
- On tab creation (`tabs.onCreated`)
- On tab update (`tabs.onUpdated` — title/URL change)
- On extension install (batch index all existing tabs)
- On demand (user triggers re-index via chat command)

### 9.4 Embedding Generation
- Each tab's content gets a vector embedding via backend
- Embeddings stored in IndexedDB alongside tab cards
- Used for semantic search and content-aware grouping
- Re-indexed only when content changes (contentHash comparison)

### 9.5 Performance
- Batch indexing: 10 tabs at a time to avoid overwhelming backend
- Incremental: only re-index changed tabs
- Background: runs when browser is idle (via `chrome.alarms`)
- Progress indicator during initial index

---

## 10. Settings & Configuration

### 10.1 Settings UI
Access via chat command "settings" or extension options page.

### 10.2 Settings Categories
- **AI**: backend URL, model selection, API key, auto-index toggle
- **Tab Strip**: position (top/bottom), height, auto-hide delay, theme
- **Chat Sidebar**: position (right/left), width, shortcut key
- **Sessions**: auto-save on close, default restore behavior
- **Cleanup**: staleness threshold, auto-suggest frequency
- **Export/Import**: default export format, auto-backup

### 10.3 Keyboard Shortcuts
| Action | Default Shortcut | Configurable |
|--------|-----------------|--------------|
| Open AI chat | Ctrl+Shift+G | Yes |
| Toggle tab strip | Ctrl+Shift+T | Yes |
| Search tabs | Ctrl+F (in strip) | No |
| Undo last action | Ctrl+Shift+Z | Yes |
| Save session | Ctrl+Shift+S | Yes |

---

## 11. Backend Requirements

### 11.1 Django Backend (Existing, Minimal Changes)
- `/api/chat` — LLM inference for natural language commands
- `/api/embeddings` — vector embedding generation
- `/api/summarize` — content summarization

### 11.2 New Backend Needs
- No new endpoints required for v2 features
- All new features (session management, export/import, cleanup) are client-side
- Backend only handles AI inference (chat, embeddings, summarization)

---

## 12. Architecture Constraints

### 12.1 Chrome Extension Manifest V3
- Service worker background (no persistent state)
- Content script for UI injection (Shadow DOM)
- IndexedDB for persistent storage
- Chrome APIs: tabs, tabGroups, bookmarks, history, scripting, storage, alarms

### 12.2 Code Organization
- `src/background/` — service worker + message handlers
- `src/ui/` — content script + Shadow DOM components
- `src/services/` — API wrappers (Chat, Embedding, Tab, Session)
- `src/services/retrieval/` — AI pipeline modules
- `src/models/` — data models (TabCard, Session)
- `src/storage/` — IndexedDB operations
- `backend/` — Django backend (unchanged)

### 12.3 No External Dependencies
- Vanilla JS (no React, no framework)
- No build step (no webpack, no bundler)
- Direct Chrome API access
- Shadow DOM for style isolation

---

## 13. What NOT to Build

Explicitly out of scope for v2:
- Cloud sync / account system
- Mobile browser support
- Firefox/Safari support
- Vertical sidebar tab strip
- Built-in ad blocker or privacy features
- Tab snooze/timer functionality
- Collaborative tab sharing (real-time)
- AI tab summarization in the strip (only on demand in chat)

---

## 14. Success Criteria

The rebuild is complete when:

1. **Tab strip renders correctly** on all pages without pushing content
2. **AI chat sidebar** opens/closes smoothly, accepts commands, shows previews
3. **Smart grouping** works for domain commands (deterministic) AND content-based commands (semantic)
4. **Session save/restore** preserves tab state including groups and pinned status
5. **Export/import** produces valid JSON that restores tabs on another browser
6. **All tab operations** (close, pin, group, bookmark) work via natural language
7. **Undo** works for destructive operations
8. **Cleanup** detects duplicates and stale tabs
9. **Search** filters tabs by title/URL/content
10. **No regressions**: existing deterministic fast path still works
11. **Premium UI**: smooth animations, dark theme, consistent cross-tab state
12. **Performance**: deterministic commands <100ms, semantic commands <5s (excluding LLM)
