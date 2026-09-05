// GOLD CRITIC pass 2 (clean): re-derive by command-text lookup. No index math.
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(__dirname + '/real-v1.pool.json', 'utf8'));
const tabs = p.tabs;
const recs = fs.readFileSync(__dirname + '/real-v1.commands.jsonl', 'utf8').trim().split('\n')
  .map(l => JSON.parse(l)).filter(r => r.command);
const byCmd = new Map(recs.map(r => [r.command, r]));

function hostname(u){try{return new URL(u).hostname.toLowerCase();}catch(e){return null;}}
function pathname(u){try{return new URL(u).pathname.toLowerCase();}catch(e){return '';}}
function registrable(u){
  const h=hostname(u); if(!h) return null;
  const bare=h.replace(/^www\./,''); const parts=bare.split('.');
  const two=['co.uk','com.au','co.in','co.jp','com.br','org.uk','co.za','com.mx'];
  if(parts.length<=2) return bare;
  for(const t of two) if(bare.endsWith('.'+t)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
const title=t=>t.title||'';
const dom=u=>registrable(u);
const host=t=>hostname(t.url);
const sortIds=a=>[...new Set(a)].sort((x,y)=>x-y);
let fails=0, total=0;
function chk(cmdText, derived){
  const cmd = byCmd.get(cmdText);
  if(!cmd){ console.log('NOT FOUND:', cmdText); fails++; return; }
  total++;
  const d=sortIds(derived), g=sortIds(cmd.expectedTabIds||[]);
  const miss=g.filter(x=>!d.includes(x)), extra=d.filter(x=>!g.includes(x));
  if(!miss.length && !extra.length) console.log('PASS ('+g.length+')', cmdText);
  else { fails++;
    console.log('FAIL ('+g.length+' gold / '+d.length+' derived)', cmdText, '@L'+(recs.indexOf(cmd)+1));
    if(miss.length) console.log('   missing-from-derived:', miss.join(','));
    if(extra.length) console.log('   extra-in-derived:', extra.join(','));
  }
  // mns sanity: gold never overlaps mustNotSelect
  const mns = cmd.mustNotSelect||[];
  const overlap = mns.filter(x=>g.includes(x));
  if(overlap.length) console.log('   !! gold∩mustNotSelect:', overlap.join(','));
}

// cat1 domains/hosts
chk('group all youtube tabs', tabs.filter(t=>dom(t.url)==='youtube.com').map(t=>t.id));
chk('close my github tabs', tabs.filter(t=>dom(t.url)==='github.com').map(t=>t.id));
chk('close tabs from chatgpt.com', tabs.filter(t=>dom(t.url)==='chatgpt.com').map(t=>t.id));
chk('close tabs from gemini.google.com', tabs.filter(t=>host(t)==='gemini.google.com').map(t=>t.id));
chk('close all docs.google.com tabs', tabs.filter(t=>host(t)==='docs.google.com').map(t=>t.id));
chk('close tabs from codeforces.com', tabs.filter(t=>dom(t.url)==='codeforces.com').map(t=>t.id));
chk('close maang.in tabs', tabs.filter(t=>dom(t.url)==='maang.in').map(t=>t.id));
chk('close geeksforgeeks tabs', tabs.filter(t=>dom(t.url)==='geeksforgeeks.org').map(t=>t.id));
chk('close amazon.in shopping tabs', tabs.filter(t=>(host(t)||'').replace(/^www\./,'')==='amazon.in').map(t=>t.id));
chk('close reddit tabs', tabs.filter(t=>dom(t.url)==='reddit.com').map(t=>t.id));
chk('close tabs from arxiv.org', tabs.filter(t=>dom(t.url)==='arxiv.org').map(t=>t.id));
chk('close tabs from huggingface.co', tabs.filter(t=>dom(t.url)==='huggingface.co').map(t=>t.id));
chk('close linkedin tabs', tabs.filter(t=>dom(t.url)==='linkedin.com').map(t=>t.id));
chk('close instagram tabs', tabs.filter(t=>dom(t.url)==='instagram.com').map(t=>t.id));
chk('close tiktok tabs', tabs.filter(t=>dom(t.url)==='tiktok.com').map(t=>t.id));
chk('close neetcode tabs', tabs.filter(t=>dom(t.url)==='neetcode.io').map(t=>t.id));
chk('close whatsapp tabs', tabs.filter(t=>dom(t.url)==='whatsapp.com').map(t=>t.id));
chk('close tabs from openai.com', tabs.filter(t=>dom(t.url)==='openai.com').map(t=>t.id));
chk('close localhost tabs', tabs.filter(t=>['localhost','127.0.0.1'].includes(host(t))).map(t=>t.id));
chk('close tabs whose url contains utm_source', tabs.filter(t=>t.url.toLowerCase().includes('utm_source')).map(t=>t.id));
chk('close chrome web store tabs', tabs.filter(t=>host(t)==='chromewebstore.google.com').map(t=>t.id));

// cat2 paths
chk('close leetcode discuss tabs', tabs.filter(t=>dom(t.url)==='leetcode.com'&&pathname(t.url).startsWith('/discuss/')).map(t=>t.id));
chk('group leetcode contest tabs', tabs.filter(t=>dom(t.url)==='leetcode.com'&&pathname(t.url).startsWith('/contest/')).map(t=>t.id));
chk('close youtube shorts tabs', tabs.filter(t=>dom(t.url)==='youtube.com'&&pathname(t.url).startsWith('/shorts/')).map(t=>t.id));
chk('group youtube watch pages', tabs.filter(t=>dom(t.url)==='youtube.com'&&pathname(t.url)==='/watch').map(t=>t.id));
chk('close youtube channel tabs', tabs.filter(t=>dom(t.url)==='youtube.com'&&/^\/@/.test(pathname(t.url))).map(t=>t.id));
chk('close github pull request tabs', tabs.filter(t=>dom(t.url)==='github.com'&&pathname(t.url).includes('/pull/')).map(t=>t.id));
chk('close github blob tabs', tabs.filter(t=>dom(t.url)==='github.com'&&pathname(t.url).includes('/blob/')).map(t=>t.id));
chk('group github tree browse tabs', tabs.filter(t=>dom(t.url)==='github.com'&&pathname(t.url).includes('/tree/')).map(t=>t.id));
chk('close codeforces problem tabs', tabs.filter(t=>dom(t.url)==='codeforces.com'&&/\/problemset|\/contest\/\d+\/problem\//.test(pathname(t.url))).map(t=>t.id));
chk('close arxiv pdf tabs', tabs.filter(t=>dom(t.url)==='arxiv.org'&&pathname(t.url).startsWith('/pdf/')).map(t=>t.id));
chk('close google drive folder tabs', tabs.filter(t=>host(t)==='drive.google.com'&&pathname(t.url).startsWith('/drive/folders/')).map(t=>t.id));
chk('close colab notebook tabs', tabs.filter(t=>host(t)==='colab.research.google.com').map(t=>t.id));

// cat3 title
chk('close tabs whose title contains stone game', tabs.filter(t=>/stone game/i.test(title(t))).map(t=>t.id));
chk('close tabs whose title contains jump game', tabs.filter(t=>/jump game/i.test(title(t))).map(t=>t.id));
chk('group tabs whose title contains binary', tabs.filter(t=>/binary/i.test(title(t))).map(t=>t.id));
chk('close tabs whose title contains access denied', tabs.filter(t=>/access denied/i.test(title(t))).map(t=>t.id));
chk('close tabs whose title contains page not found', tabs.filter(t=>/page not found/i.test(title(t))).map(t=>t.id));
chk('group tabs whose title contains amazon and interview', tabs.filter(t=>/amazon/i.test(title(t))&&/interview/i.test(title(t))).map(t=>t.id));
chk('close tabs whose title contains slowed', tabs.filter(t=>/slowed/i.test(title(t))).map(t=>t.id));
chk('close tabs whose title starts with leetcode', tabs.filter(t=>/^leetcode/i.test(title(t).trim())).map(t=>t.id));
chk('close tabs whose title contains interview experience', tabs.filter(t=>/interview experience/i.test(title(t))).map(t=>t.id));

// cat5
chk('group all pinned tabs', tabs.filter(t=>t.pinned).map(t=>t.id));
chk('close my pinned tabs', tabs.filter(t=>t.pinned).map(t=>t.id));

// cat6
chk('close all tabs in the dev group', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('group my dev tabs', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('unpin the dev group tabs', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('mute all tabs in the dev group', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('show me the tabs in my dev group', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('sort tabs in the dev group by title', tabs.filter(t=>t.groupId==='G1').map(t=>t.id));
chk('group tabs in window 2', tabs.filter(t=>t.windowId===2).map(t=>t.id));
chk('close all tabs to the right of the current tab in this window', tabs.filter(t=>t.index>549).map(t=>t.id));

// cat7
chk('group tabs from the same website as the current tab', tabs.filter(t=>dom(t.url)==='reddit.com').map(t=>t.id));
chk('close tabs from the same site as my current tab except this one', tabs.filter(t=>dom(t.url)==='reddit.com'&&t.id!==550).map(t=>t.id));

// cat8 dup
chk('close duplicate tabs', (()=>{const by={};for(const t of tabs)(by[t.url]=by[t.url]||[]).push(t);const out=[];for(const c of Object.values(by).filter(v=>v.length>1)){const s=[...c].sort((a,b)=>a.index-b.index);out.push(...s.slice(1).map(t=>t.id));}return out;})());
chk('group my duplicate leetcode problem tabs', tabs.filter(t=>dom(t.url)==='leetcode.com'&&pathname(t.url).startsWith('/problems/')).map(t=>t.id));
chk('close the duplicate amazon interview experience tabs keeping the first', [557]); // cluster [548,557], keep 548
chk('close the duplicate whatsapp tab', [502]); // cluster [490,502], keep 490
chk('close duplicate gemini chats about merging alexa devices', [541]); // cluster [523,541], keep 523
chk('close duplicate hermes agent chatgpt tabs', [525]); // cluster [517,525], keep 517
chk('close duplicate tabs of the 5 ai engineer projects youtube video keeping the first', [144]); // cluster [5,144]

// cat10
chk('close all PDF tabs', tabs.filter(t=>t.url.toLowerCase().endsWith('.pdf')).map(t=>t.id));
chk('group local file tabs', tabs.filter(t=>t.url.startsWith('file://')).map(t=>t.id));
chk('close google sheets tabs', tabs.filter(t=>dom(t.url)==='docs.google.com'&&pathname(t.url).startsWith('/spreadsheets/')).map(t=>t.id));
chk('group google docs documents', tabs.filter(t=>host(t)==='docs.google.com'&&pathname(t.url).startsWith('/document/d/')).map(t=>t.id));

// cat11 topics
chk('group tabs about machine learning', tabs.filter(t=>/machine learning|mlops|deep learning|neural network/i.test(title(t))).map(t=>t.id));
chk('close tabs about llms', tabs.filter(t=>/\bllms?\b|large language model|\bgpt\b|nanogpt|mingpt|transformer/i.test(title(t))).map(t=>t.id));
chk('group my amazon interview prep tabs', tabs.filter(t=>/amazon/i.test(title(t))&&/(interview|bar raiser|leadership)/i.test(title(t))).map(t=>t.id));
chk('close fitness tabs', tabs.filter(t=>/workout|biceps|push-?up|muscle|mentzer|exercise|jogging|fitness|gym/i.test(title(t))).map(t=>t.id));
chk('close anime tabs', tabs.filter(t=>/anime|manga|chiaanime|attack on titan|berserk|nakamura/i.test(title(t))||t.url.includes('chiaanime')).map(t=>t.id));
chk('group my slowed reverb music tabs', tabs.filter(t=>/slowed/i.test(title(t))).map(t=>t.id));
chk('close competitive programming tabs', tabs.filter(t=>['codeforces.com','codechef.com','maang.in','cp-algorithms.com','neetcode.io'].includes(dom(t.url))).map(t=>t.id));
chk('group tabs about rag', tabs.filter(t=>/\brag\b|retrieval[- ]augmented/i.test(title(t))).map(t=>t.id));
chk('close trading tabs', tabs.filter(t=>/trading|stock market|forex|price movement|candlestick/i.test(title(t))).map(t=>t.id));
chk('close backend course tabs', tabs.filter(t=>/backend|microservices|kafka/i.test(title(t))).map(t=>t.id));
chk('close vibe coding tabs', tabs.filter(t=>/vibe cod/i.test(title(t))).map(t=>t.id));
chk('close gsoc tabs', tabs.filter(t=>/gsoc|google summer of code/i.test(title(t))).map(t=>t.id));
chk('close shopping tabs', tabs.filter(t=>t.category==='shopping').map(t=>t.id));

// cat12
chk('group tabs about claude', tabs.filter(t=>host(t)==='claude.ai'||/claude/i.test(title(t))).map(t=>t.id));
chk('close tabs about gemini', tabs.filter(t=>host(t)==='gemini.google.com'||/gemini/i.test(title(t))).map(t=>t.id));
chk('close tabs about chatgpt', tabs.filter(t=>host(t)==='chatgpt.com'||/chatgpt/i.test(title(t))).map(t=>t.id));
chk('close tabs about karpathy', tabs.filter(t=>/karpathy|nanogpt|mingpt/i.test(title(t))).map(t=>t.id));
chk('close tabs about docker', tabs.filter(t=>/docker/i.test(title(t))).map(t=>t.id));
chk('close tabs about python', tabs.filter(t=>/python/i.test(title(t))).map(t=>t.id));
chk('group amazon leadership principles tabs', tabs.filter(t=>/leadership principle/i.test(title(t))).map(t=>t.id));
chk('close tabs about ollama', tabs.filter(t=>/ollama/i.test(title(t))).map(t=>t.id));
chk('close tabs about rust', tabs.filter(t=>/rust/i.test(title(t))).map(t=>t.id));

// cat14 search
chk('close all google search tabs', tabs.filter(t=>host(t)==='google.com'&&pathname(t.url)==='/search').map(t=>t.id));
chk('close bing search tabs', tabs.filter(t=>dom(t.url)==='bing.com').map(t=>t.id));
chk('close youtube search results tabs', tabs.filter(t=>dom(t.url)==='youtube.com'&&pathname(t.url)==='/results').map(t=>t.id));
chk('group tabs from search engines', tabs.filter(t=>(host(t)==='google.com'&&pathname(t.url)==='/search')||(dom(t.url)==='bing.com')||(dom(t.url)==='youtube.com'&&pathname(t.url)==='/results')||(dom(t.url)==='reddit.com'&&pathname(t.url).includes('/search'))).map(t=>t.id));
chk('close reddit search tabs', tabs.filter(t=>dom(t.url)==='reddit.com'&&pathname(t.url).includes('/search')).map(t=>t.id));
chk('close search tabs about anime', tabs.filter(t=>((host(t)==='google.com'&&pathname(t.url)==='/search')||dom(t.url)==='bing.com'||(dom(t.url)==='youtube.com'&&pathname(t.url)==='/results')||(dom(t.url)==='reddit.com'&&pathname(t.url).includes('/search')))&&/anime/i.test(title(t))).map(t=>t.id));

// cat18
chk('close broken pages', tabs.filter(t=>/page not found|access denied/i.test(title(t))).map(t=>t.id));

// cat24 positional
chk('close the last five tabs', tabs.slice(-5).map(t=>t.id));
chk('close the first three tabs', tabs.slice(0,3).map(t=>t.id));
chk('group the first ten github tabs', tabs.filter(t=>dom(t.url)==='github.com').slice(0,10).map(t=>t.id));
chk('close the first five leetcode problem tabs', tabs.filter(t=>dom(t.url)==='leetcode.com'&&pathname(t.url).startsWith('/problems/')).slice(0,5).map(t=>t.id));
chk('group the last three gemini tabs', tabs.filter(t=>host(t)==='gemini.google.com').slice(-3).map(t=>t.id));
chk('bookmark the last two amazon shopping tabs', tabs.filter(t=>t.category==='shopping').slice(-2).map(t=>t.id));

// cat25 boolean
chk('close leetcode tabs that are not about binary', tabs.filter(t=>dom(t.url)==='leetcode.com'&&!/binary/i.test(title(t))).map(t=>t.id));
chk('close github tabs about llm or rag', tabs.filter(t=>dom(t.url)==='github.com'&&/\bllm\b|\brag\b|gpt|retrieval/i.test(title(t))).map(t=>t.id));
chk('close youtube tabs but keep shorts', tabs.filter(t=>dom(t.url)==='youtube.com'&&pathname(t.url)!=='/shorts/').map(t=>t.id));
chk('close tabs from codeforces or leetcode', tabs.filter(t=>['codeforces.com','leetcode.com'].includes(dom(t.url))).map(t=>t.id));
chk('close amazon tabs that are not shopping pages', tabs.filter(t=>['amazon.com','amazon.jobs','amazon.in'].includes(dom(t.url))&&t.category!=='shopping').map(t=>t.id));
chk('group machine learning tabs that are videos', tabs.filter(t=>/machine learning|mlops|deep learning|neural network/i.test(title(t))&&dom(t.url)==='youtube.com').map(t=>t.id));
chk('close interview tabs except amazon ones', tabs.filter(t=>/interview/i.test(title(t))&&!/amazon/i.test(title(t))).map(t=>t.id));
chk('close my fitness or anime tabs', tabs.filter(t=>/workout|biceps|push-?up|muscle|mentzer|exercise|jogging|fitness|gym/i.test(title(t))||/anime|manga|chiaanime|attack on titan|berserk|nakamura/i.test(title(t))||t.url.includes('chiaanime')).map(t=>t.id));
chk('close gemini chats about rag', tabs.filter(t=>host(t)==='gemini.google.com'&&/\brag\b|retrieval|reranking/i.test(title(t))).map(t=>t.id));
chk('close reddit tabs that are not in the dev group', tabs.filter(t=>dom(t.url)==='reddit.com'&&t.groupId!=='G1').map(t=>t.id));

// cat26
chk('close all tabs except those in the dev group', tabs.filter(t=>t.groupId!=='G1').map(t=>t.id));
chk('close all gemini tabs except the rag ones', tabs.filter(t=>host(t)==='gemini.google.com'&&!/\brag\b|retrieval|reranking/i.test(title(t))).map(t=>t.id));

console.log('\n>>> pass2 clean: '+(total-fails)+'/'+total+' match, '+fails+' fail');
