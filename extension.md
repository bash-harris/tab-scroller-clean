
once actions such as close, mute, pin, bookmark, and group exist, the interesting problem is building a powerful tab-selection language. The extension should treat every command as:

Action + tab filter + optional exclusions + optional ranking/limit

For example:

Close + tabs about C++ + opened this week + except GitHub + keep the three most recently used.

A practical note: Chrome exposes properties such as URL, title, pinned state, active state, audio state, group, window, and related metadata through the Tabs API. Browsing frequency and last-visit information can come from the History API, while recently closed tabs can come from the Sessions API. Exact “tab opened at” and interaction metrics generally need to be recorded by the extension itself. Semantic page filtering requires page access, content scripts, or previously generated page representations.

Difficulty scale
Level 1, Easy: Direct browser metadata comparison
Level 2, Moderate: Extension-maintained state or structured URL parsing
Level 3, Advanced: Rule combinations, entity extraction, heuristics
Level 4, Hard: Semantic classification or page-content analysis
Level 5, Very hard: User intent, behavioral prediction, cross-tab reasoning
1. URL and domain filters
Level 1: Direct metadata
All tabs from github.com
All tabs not from github.com
All tabs from GitHub or Stack Overflow
All tabs from GitHub and its subdomains
All tabs from exactly docs.github.com, excluding other GitHub pages
All tabs whose URL contains dashboard
All tabs whose URL starts with a given path
All tabs whose URL ends with .pdf
All tabs using HTTP rather than HTTPS
All tabs opened from localhost
All tabs using a particular port
All tabs whose URL contains query parameters
All tabs whose URL contains a fragment
All tabs whose domain matches a wildcard such as *.microsoft.com
All tabs from domains in a supplied list
All tabs except domains in a supplied list
All tabs from the same website as the current tab
All tabs from the same subdomain as the current tab
All tabs from a specified top-level domain such as .org, .edu, or .in
All tabs matching a regular expression, as an advanced-user feature
Examples
“Close all localhost tabs except port 3000.”
“Group all .edu websites.”
“Bookmark tabs under developer.chrome.com/docs.”
“Close all GitHub tabs except pull requests.”
Level 2: Structured URL interpretation
GitHub tabs belonging to a particular repository
GitHub pull-request tabs
GitHub issue tabs
YouTube video tabs but not channel pages
Amazon product pages but not search pages
Google Docs documents but not Sheets or Slides
Jira issue pages but not dashboards
Confluence pages from a particular space
Stack Overflow question pages with a particular tag
Documentation pages for a specified product or version
Search-result pages for a particular query
Tabs representing the same resource with different tracking parameters
Examples
“Close GitHub issue tabs, but keep pull requests.”
“Group all Jira tickets from project XC.”
“Close duplicate product pages even if their tracking parameters differ.”
2. Title-based filters
Level 1
Tabs whose title contains a word or phrase
Tabs whose title starts or ends with a phrase
Tabs whose title matches multiple keywords
Tabs whose title excludes a keyword
Tabs with an empty title
Tabs whose title is identical to another open tab
Tabs whose title matches a wildcard or regular expression
Tabs with unusually long titles
Tabs whose title is still “Loading”
Tabs whose title contains an error indicator
Examples
“Group tabs with ‘API reference’ in the title.”
“Close tabs containing ‘404’ or ‘Page not found’.”
“Bookmark tabs whose titles contain both C++ and concurrency.”
Level 3
Tabs whose title approximately matches a phrase
Tabs with misspelled or alternate versions of a keyword
Tabs whose titles refer to the same named entity
Tabs whose titles indicate a tutorial, reference, article, product, or discussion
Tabs whose titles appear to represent different parts of the same task
3. Time-based filters

This category should distinguish several different clocks.

A. Tab creation time
Level 2

The extension must normally record creation timestamps itself.

Opened in the last N minutes or hours
Opened today, yesterday, or this week
Opened before or after a specified time
Opened between two dates
Opened during a named period such as “before lunch”
Opened during a particular weekday
Opened during work hours
Opened outside work hours
Opened before or after another tab
Opened during the current browser session
Examples
“Close shopping tabs opened after 10 PM.”
“Group tabs opened between yesterday afternoon and this morning.”
“Bookmark all research tabs opened before lunch.”
B. Last activation time
Level 2

Requires tracking tabs.onActivated or equivalent tab events.

Tabs not viewed in the last N hours
Tabs last viewed today
Tabs untouched since yesterday
Tabs not activated during the current session
Tabs used recently
Tabs used before a given meeting or event
Tabs used within a specific time range
Examples
“Close tabs I haven’t looked at for seven days.”
“Keep only tabs used in the last two hours.”
“Group tabs I worked with this morning.”
C. Total active time
Level 2 to 3

Requires usage tracking.

Tabs viewed for less than N seconds
Tabs used for more than N minutes
Tabs that were briefly opened and abandoned
Tabs with the highest active time today
Tabs consuming most of the user’s browsing time
Tabs repeatedly revisited during a period
Examples
“Close tabs I viewed for less than ten seconds.”
“Bookmark research tabs I spent more than five minutes reading.”
D. Historical browsing time
Level 2 to 3
URLs not visited for N days
URLs visited this month
Pages frequently visited during a period
Tabs whose URLs have never previously been visited
Tabs rediscovered after a long period
Tabs last visited before a specified date

The History API provides properties such as last visit time, visit count, and typed count, subject to permission requirements.

4. Tab-state filters
Level 1
Active tab
Inactive tabs
Pinned tabs
Unpinned tabs
Muted tabs
Unmuted tabs
Tabs currently playing audio
Tabs that recently played audio
Grouped tabs
Ungrouped tabs
Tabs in a particular group
Tabs in the current window
Tabs in other windows
Tabs in minimized windows
Tabs in the last-focused window
Highlighted or selected tabs
Discarded or suspended tabs
Tabs that can be discarded
Tabs still loading
Completely loaded tabs
Tabs opened in incognito mode, where permitted
Tabs with a specific favicon
Tabs without a favicon
Tabs showing a permission or capture indicator, where accessible
Tabs sharing audio or video, where detectable
Tabs with unsaved form state, if detectable through page inspection
Examples
“Close all unpinned tabs in this window.”
“Group tabs currently playing audio.”
“Close discarded tabs except pinned ones.”
“Bookmark all ungrouped tabs.”
5. Window, group, and position filters
Level 1
Tabs in the current window
Tabs in window 2
Tabs in all windows except the current one
Tabs in a named window, if your extension allows naming
Tabs in a particular tab group
Tabs in groups of a particular color
Tabs before or after the current tab
Tabs to the left or right of the current tab
First or last N tabs
Tabs between two specified tabs
Every second tab
Tabs at specified positions
Tabs adjacent to the current tab
Tabs outside any group
Tabs in groups containing more than N tabs
Examples
“Close all tabs to the right except pinned tabs.”
“Bookmark the first five tabs in this window.”
“Move ungrouped tabs between GitHub and Jira into a new group.”
Level 2
Tabs in the group created yesterday
Tabs in the group containing the current tab
Tabs in groups whose names match a topic
Tabs in groups inactive for several days
Tabs belonging to automatically created groups
Tabs manually grouped by the user
6. Relationship-to-current-tab filters
Level 1 to 2
Same domain as this tab
Different domain from this tab
Same tab group as this tab
Tabs adjacent to this tab
Tabs opened after this tab
Tabs opened before this tab
Tabs with titles similar to this tab
Tabs with the same URL path structure
Tabs linking to the same repository, project, product, or document
Level 3 to 4
Tabs related to the topic of the current tab
Tabs that provide supporting material for the current tab
Tabs that contradict the current tab
Tabs that are earlier or newer versions of the current page
Tabs that cite or reference the current page
Tabs opened from the current page
Tabs from which the current page was opened
Tabs belonging to the same browsing chain
Examples
“Group tabs opened from this page.”
“Close everything unrelated to the current tab.”
“Bookmark tabs that explain concepts mentioned on this page.”

Tracking parent-child relationships is easiest if the extension captures opener information and navigation events as tabs are created.

7. Duplicate and similarity filters
Level 1: Exact duplicates
Tabs with exactly the same URL
Tabs with the same normalized URL
Tabs with identical titles
Tabs duplicated within the same window
Tabs duplicated across windows
Bookmarked tabs that are also open
Multiple blank or new-tab pages
Duplicate file URLs
Examples
“Close duplicate tabs and keep the oldest.”
“Close duplicates in other windows.”
“Keep one copy of each URL per group.”
Level 2: Canonical duplicates
Same URL after removing tracking parameters
Same page with different fragments
Same page with different protocol or trailing slash
Mobile and desktop forms of the same page
Print and normal views of the same page
AMP and canonical versions
Same document opened through different redirect URLs
Level 4: Semantic duplicates
Different articles covering effectively the same information
Product pages for the same product on different sites
Documentation pages explaining the same API
Different URLs displaying substantially identical content
Multiple discussions answering the same question
Older and newer versions of the same documentation
Useful retention modifiers
Keep oldest
Keep newest
Keep most recently used
Keep bookmarked
Keep pinned
Keep the most complete page
Keep the official source
Keep one per window
Keep one per domain
8. Page-content filters
Level 3: Deterministic content matching
Pages containing a word or exact phrase
Pages not containing a word
Pages containing all supplied keywords
Pages containing any supplied keyword
Pages containing a visible link to a domain
Pages containing an email address
Pages containing a phone number
Pages containing a date
Pages containing a code block
Pages containing a table
Pages containing downloadable files
Pages containing forms
Pages containing a video or audio player
Pages containing specific HTML metadata
Pages containing schema.org structured data
Pages containing a selected piece of text
Pages written in a particular language
Pages with a particular author, if metadata exists
Pages published or updated during a time range, if metadata exists
Examples
“Bookmark tabs containing C++ code.”
“Group pages that mention both OAuth and refresh tokens.”
“Close product pages that say ‘out of stock’.”
“Group pages containing downloadable PDFs.”
Level 4: Semantic content matching
Pages about a concept, even if the exact word is absent
Pages answering a particular question
Pages supporting a particular argument
Pages critical of a product or approach
Pages describing advantages
Pages describing limitations
Pages containing implementation instructions
Pages containing beginner explanations
Pages containing advanced technical discussion
Pages focused on theory versus practical implementation
Pages relevant to a given task
Pages mentioning a person, organization, product, or location
Pages comparing two named items
Pages discussing a particular problem indirectly
Pages with content similar to supplied natural-language text
Examples
“Group tabs that explain how browser service workers lose state.”
“Bookmark tabs containing practical solutions, not general descriptions.”
“Close pages that only mention Kubernetes briefly.”
“Keep pages where OAuth is a main topic.”

The last example introduces an important distinction:

Mentioned topic versus primary topic

That should be a supported filter modifier.

9. Content-type and page-purpose filters
Level 2: URL and metadata heuristics
Articles
Documentation
API references
Tutorials
Videos
PDFs
Images
Source-code repositories
Blog posts
News pages
Product pages
Search-result pages
Dashboards
Login pages
Forms
Issue trackers
Pull requests
Discussion forums
Social-media posts
Chat applications
Email tabs
Online documents
Spreadsheets
Presentations
Maps
Calendar pages
Level 4: Semantic classification
Beginner tutorials
Advanced tutorials
Opinion pieces
Primary sources
Secondary sources
Official documentation
Community answers
Academic papers
Reviews
Comparisons
Troubleshooting pages
Reference material
Actionable guides
Promotional pages
Low-information pages
Pages requiring further reading
Examples
“Bookmark official documentation about FastMCP.”
“Close promotional pages related to Python courses.”
“Group tutorials separately from API references.”
“Keep primary sources and close repeated news coverage.”
10. Topic and category filters
Level 4
Tabs related to topic Y
Tabs primarily about Y
Tabs that mention Y
Tabs about Y but not Z
Tabs about either Y or Z
Tabs about both Y and Z
Tabs about a subtopic of Y
Tabs belonging to broader category Y
Tabs unrelated to Y
Tabs loosely related to Y
Tabs strongly related to Y
Tabs belonging to one of N user-provided categories
Tabs that do not fit any supplied category
Tabs spanning multiple categories
Tabs with ambiguous categorization
Examples
“Group tabs strongly related to C++ concurrency.”
“Close AI tabs that are not about local models.”
“Group browser-extension tabs into permissions, UI, storage, and NLP.”
“Bookmark tabs that fit both security and authentication.”
Useful semantic thresholds

Let users specify:

Exact match
Strongly related
Broadly related
Mention only
Primary topic
Secondary topic
Exclude ambiguous matches

This makes semantic filtering more predictable.

11. Entity-based filters
Level 3 to 4
Tabs about a named person
Tabs about a company
Tabs about a product
Tabs about a software library
Tabs about a programming language
Tabs about a location
Tabs about an event
Tabs about a project
Tabs about a repository
Tabs about a Jira ticket
Tabs about a customer
Tabs about a meeting
Tabs about a document
Tabs about a particular version or release
Tabs mentioning competitors of a company
Examples
“Group tabs related to React, excluding React Native.”
“Bookmark pages about Bosch Bengaluru.”
“Close tabs about Python 2, but keep Python 3.”
“Group pages for Jira tickets XC-120 through XC-150.”

Entity disambiguation makes this harder:

Java the language versus Java the island
Edge the browser versus edge computing
Apple the company versus the fruit
12. Navigation-origin filters
Level 2 to 3

Requires the extension to record navigation and opener relationships.

Tabs opened by clicking links
Tabs opened by typing a URL
Tabs opened from bookmarks
Tabs opened from search results
Tabs opened by another extension
Tabs restored from a previous session
Tabs opened from the current page
Tabs opened by a specific parent tab
Tabs created automatically by a website
Tabs resulting from redirects
Tabs opened from external applications
Tabs opened from notifications
Tabs reached through form submission
Tabs reached through browser suggestions

Chrome history can expose navigation transition types such as link, typed, bookmark-generated, form submission, reload, and other transition categories.

Examples
“Close tabs automatically opened by websites.”
“Group tabs opened from Google search results.”
“Bookmark pages I opened directly from bookmarks.”
“Close redirected tabs but keep directly opened pages.”
13. Search-query filters
Level 2 to 3
Tabs opened from a search for X
Tabs resulting from the same search query
Tabs opened from Google, Bing, or another search engine
Search-result pages whose query contains a phrase
Tabs opened from search results within a time range
Tabs opened from the first N results, if tracked
Tabs from image search
Tabs from shopping search
Tabs from academic search
Tabs opened across multiple searches for the same research task
Examples
“Group pages I opened while searching for FastMCP installation.”
“Close Google search pages but keep the results I opened.”
“Bookmark results from my C++ concurrency searches.”
14. Interaction-based filters
Level 2 to 3

The extension must track user activity.

Tabs never activated
Tabs activated only once
Tabs revisited more than N times
Tabs used for more than N minutes
Tabs the user scrolled through
Tabs the user did not scroll
Tabs where the user reached the bottom
Tabs where text was selected
Tabs where content was copied
Tabs where the user typed into a form
Tabs where the user downloaded something
Tabs where the user clicked an external link
Tabs where the user performed a search
Tabs opened and immediately abandoned
Tabs frequently switched between
Tabs used consecutively as part of a workflow
Examples
“Close tabs I never viewed.”
“Bookmark articles I read to the end.”
“Group tabs I repeatedly switched between.”
“Keep pages where I copied code.”

Some signals may feel invasive, so they should be opt-in, locally stored, clearly explained, and easy to disable.

15. Reading-progress filters
Level 2 to 4
Unread tabs
Partially read tabs
Completely read tabs
Tabs with less than N% scroll progress
Tabs with more than N% scroll progress
Long articles not yet finished
Read-later tabs
Pages estimated to take less than N minutes
Pages estimated to take more than N minutes
Tabs with unfinished videos
Tabs with completed videos
Tabs where the user stopped near a heading or section
Examples
“Group unread articles into a Reading group.”
“Close articles I have finished.”
“Bookmark partially read technical articles.”
“Keep pages with less than five minutes remaining.”
16. Bookmark-related filters
Level 1 to 2
Open tabs that are already bookmarked
Open tabs that are not bookmarked
Tabs bookmarked in folder A
Tabs bookmarked during a time period
Tabs appearing in multiple bookmark folders
Tabs with duplicate bookmarks
Tabs bookmarked but not visited recently
Open pages related to bookmarks in folder A
Tabs whose parent domain is represented in a bookmark folder
Tabs matching bookmark tags, if the extension supports tags
Examples
“Close open tabs that are already bookmarked.”
“Group tabs bookmarked under C++.”
“Move bookmarks for open GitHub tabs into Development.”
“Bookmark unbookmarked research tabs only.”
17. History and frequency filters
Level 2
Most frequently visited open tabs
Least frequently visited open tabs
Tabs visited more than N times
Tabs visited only once
Tabs never visited before today
Tabs with high typed-navigation counts
Tabs frequently visited during working hours
Tabs historically visited on weekdays
Tabs not visited for several months
Tabs repeatedly reopened after being closed
Examples
“Pin my five most frequently visited work tabs.”
“Close tabs I have visited only once and not used today.”
“Group websites I visit every weekday.”
18. Error and health-state filters
Level 2 to 3
Tabs that failed to load
Tabs showing DNS errors
Tabs showing connection errors
Tabs with HTTP 404 pages
Tabs with server errors
Tabs stuck loading for more than N seconds
Tabs redirected repeatedly
Tabs showing certificate warnings
Tabs requiring login
Tabs with expired sessions
Tabs showing access-denied messages
Tabs showing “content unavailable”
Tabs that have crashed
Tabs consuming excessive resources, if measurable
Tabs that repeatedly reload
Examples
“Close tabs that failed to load.”
“Group pages asking me to sign in.”
“Reload tabs stuck loading for more than 30 seconds.”
“Close unavailable product pages.”

Detecting generic error text is moderate; reliably understanding site-specific error states is harder.

19. Language and geographic filters
Level 2 to 4
Tabs in English, Hindi, German, or another language
Tabs not in the user’s preferred language
Tabs matching the language of the current tab
Tabs from country-specific domains
Pages concerning a location
Pages offering services in a specified region
Local versus international versions of the same website
Pages priced in a specified currency
Pages showing availability for a geographic region
Examples
“Group German documentation separately.”
“Close product tabs that do not ship to India.”
“Keep Bengaluru-specific pages.”
“Group pages priced in INR.”

Language detection is relatively direct. Shipping availability and geographic serviceability require semantic or site-specific extraction.

20. Product, price, and availability filters
Level 3 to 5
Product tabs below or above a price
Products within a price range
Products currently in stock
Products offering delivery by a date
Products with particular ratings
Products with a minimum number of reviews
Products matching specified features
Duplicate products across retailers
Products with the lowest price
Flight tabs below a price
Hotel tabs within a rating or location range
Pages showing discounts above a percentage
Examples
“Close laptop tabs above ₹80,000.”
“Group in-stock phones with at least 256 GB storage.”
“Keep the cheapest listing for each product.”

This is difficult because page formats vary, prices can be dynamic, and content may be rendered after the page loads.

21. Task and project filters
Level 4
Tabs related to a named project
Tabs related to a Jira issue
Tabs related to the current coding task
Tabs related to a meeting
Tabs related to an onboarding activity
Tabs related to interview preparation
Tabs related to travel planning
Tabs related to a bug investigation
Tabs related to a purchase decision
Tabs related to writing a document
Tabs related to the repository currently open
Tabs supporting a particular deliverable
Examples
“Group everything related to fixing the authentication bug.”
“Close tabs unrelated to my browser-extension project.”
“Bookmark resources used for Jira ticket XC-142.”
“Keep tabs relevant to tomorrow’s presentation.”

The difficult part is establishing the task context. It can come from:

User-provided task descriptions
Named entities in open tabs
Tab-opening sequences
Connected project-management tools
Previously saved workspaces
22. Quality and authority filters
Level 4 to 5
Official sources
Primary sources
Recently updated pages
Pages with identifiable authors
Pages from trusted domains
Pages with citations
Pages without citations
Highly detailed pages
Thin or low-information pages
Pages that appear promotional
Pages likely generated automatically
Pages containing outdated instructions
Pages relevant to a specified software version
Pages whose claims are repeated by other open pages
Examples
“Keep official documentation and close community copies.”
“Bookmark detailed technical sources updated this year.”
“Close pages that only repeat information found elsewhere.”
“Keep sources relevant to Python 3.13.”

“Trusted” should not be silently decided by the model. It should use explicit criteria such as official domain, user allowlist, publication metadata, source type, or user-defined trust preferences.

23. Cross-tab comparison filters
Level 5

These select tabs based on their relationship to other open tabs.

Tabs containing unique information
Tabs repeating information already covered elsewhere
Tabs contradicting another tab
Tabs agreeing on a particular claim
Tabs representing minority viewpoints
Tabs missing a required aspect of the topic
Tabs covering the newest version
Tabs with the most comprehensive explanation
Tabs that collectively cover all requested subtopics
The smallest useful subset of tabs for a task
One representative tab from each viewpoint
One representative tab from each category
Examples
“Keep the smallest set of tabs that covers all four categories.”
“Close articles that add no new information.”
“Group sources by whether they recommend approach A or B.”
“Keep one strong tutorial, one reference, and one example.”

This is substantially harder than independent classification because every candidate must be evaluated against the full tab collection.

24. Ranking and limit filters

These are extremely useful because they can modify nearly any selector.

Level 2 to 5, depending on ranking signal
First N matching tabs
Last N matching tabs
N newest
N oldest
N most recently used
N least recently used
N most frequently visited
N longest-viewed
N shortest-viewed
N most relevant to a topic
N most similar to the current tab
N most authoritative
N most recently updated
One per domain
One per category
One per repository
One per product
All except the top N
Everything below a relevance threshold
Examples
“Bookmark the five most relevant React performance tabs.”
“Close all but the newest tab from each domain.”
“Keep one representative tab from each category.”
“Pin my three most frequently used work tabs.”
25. Compound Boolean filters
Level 3

The extension should support:

AND
OR
NOT
EXCEPT
Parentheses or natural-language grouping
Nested conditions
Relative references such as “those,” “the remaining tabs,” and “them”
Examples
“Close tabs from GitHub or GitLab that are older than a week.”
“Group tabs about C++ that contain code but are not videos.”
“Bookmark unpinned tabs opened yesterday, except pages already bookmarked.”
“Close shopping tabs unless they are pinned or currently playing audio.”
“Select tabs that are either official documentation or strongly related to the current tab, but not outdated versions.”
Level 4: Ambiguous scope

Consider:

“Close old GitHub and Stack Overflow tabs about C++.”

Possible interpretations:

Old GitHub tabs, plus all Stack Overflow tabs about C++
Old tabs from both domains, all related to C++
All old GitHub tabs, plus C++-related Stack Overflow tabs

For destructive operations, the extension should show the parsed filter and matching tab count before execution.

26. Relative and conversational filters
Level 3 to 4
Those tabs
The remaining tabs
The tabs you just grouped
The ones you excluded
The same selection as before
Similar tabs
Everything else
Apply this only to the previous results
Undo the last selection
Refine the previous filter
Example conversation

User: Group tabs related to browser extensions.
 User: Exclude Firefox pages.
 User: From the remaining tabs, bookmark official documentation.
 User: Close everything else older than three days.

This requires maintaining a short-lived selection context and command history.

27. User-defined properties and filters
Level 2 to 4

Allow users to assign:

Tags
Priority
Project
Status
Deadline
Purpose
Sensitivity
Workspace
Read-later state
Temporary/permanent state
Custom notes

Then support:

Tabs tagged research
High-priority tabs
Tabs belonging to project X
Tabs marked temporary
Tabs due this week
Tabs with no assigned project
Tabs with user notes mentioning Y
Examples
“Close temporary tabs older than two days.”
“Group high-priority tabs by project.”
“Bookmark all tabs tagged onboarding.”

This is valuable because user-defined metadata is more predictable than inferred intent.

Highest-value commands to implement first
Phase 1: Metadata filtering

Difficulty: 1 to 2

Domain, subdomain, URL path, and keyword filters
Current window, other windows, group, and position
Pinned, muted, audio, active, discarded, and loading states
Exact and normalized URL duplicates
Title filters
Basic Boolean combinations
First/last/newest/oldest N
Same domain as current tab
Phase 2: Extension-tracked filters

Difficulty: 2 to 3

Opened-time filters
Last-activated filters
Never-viewed tabs
Activation frequency and active duration
Parent-tab and browsing-chain filters
Reading progress
Search-origin filters
Session and workspace filters
Phase 3: Page inspection

Difficulty: 3 to 4

Exact page-content search
Content type detection
Language detection
Error-page and login-page detection
Structured entity and metadata extraction
Site-specific filters for GitHub, Jira, YouTube, shopping sites, and documentation
Phase 4: Semantic filtering

Difficulty: 4

Topic relevance
Primary topic versus mere mention
Page-purpose classification
Project and task relevance
Similarity to the current tab
Automatic category assignment
Named-entity disambiguation
Phase 5: Cross-tab intelligence

Difficulty: 5

Information overlap detection
Representative-tab selection
Contradiction and agreement grouping
Source-quality filtering
Minimal tab subset for a task
Predictive “safe to close” selection
“Everything needed for my current task”
Recommended command grammar

A scalable internal representation could be:

ACTION
  ON <base selection>
  WHERE <conditions>
  EXCEPT <conditions>
  ORDER BY <criterion>
  LIMIT <number>
  RETAIN <retention rule>


Example:

Close tabs
ON all windows
WHERE topic = "browser extensions"
  AND openedAt < 7 days ago
EXCEPT domain = "developer.chrome.com"
  OR pinned = true
ORDER BY lastActivated ascending
RETAIN one per category


Natural-language version:

“Close browser-extension tabs older than a week, except pinned tabs and official Chrome documentation, but keep one tab from each category.”

The strongest product direction

Rather than adding hundreds of separately coded command templates, build a composable filter system with these core primitives:

Metadata:
domain, URL, title, window, group, position, state

Time:
created, activated, visited, duration, session

Content:
keywords, language, type, topic, entity, purpose

Behavior:
view count, active duration, scroll progress, interaction

Relationship:
same as, opened from, similar to, duplicate of, related to

Modifiers:
except, only, either, both, before, after, top N, one per group


This turns a limited command list into a filter language capable of handling thousands of combinations without implementing every sentence as a separate command.
