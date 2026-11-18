# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/slides_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, zlib, struct, urllib.parse
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3951; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT","MAIL_","SMTP_","CAPTCHA_"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
def png(path, rgb, w=96, h=60):
    raw=b"".join(b"\x00"+bytes(rgb)*w for _ in range(h))
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    open(path,"wb").write(b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b""))
for n,c in [("a",(200,90,40)),("b",(40,140,90)),("c",(60,90,200)),("d",(190,160,40))]: png(f"{D}/{n}.png",c)
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
def api(method,path,body=None,cj=None,raw=None,ctype="application/json"):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    rq=urllib.request.Request(BASE+path,data=data,method=method,headers={"Content-Type":ctype} if data is not None else {})
    try:
        r=op.open(rq); t=r.read(); return r.status,(json.loads(t) if t[:1] in b"{[" else t)
    except urllib.error.HTTPError as e:
        t=e.read(); return e.code,(json.loads(t) if t[:1] in b"{[" else t)
errors=[]; results=[]
def check(c,name): results.append(c); print(("PASS " if c else "FAIL ")+name)
try:
    cj=http.cookiejar.CookieJar(); api("POST","/api/login",{"portal":"ADMINISTRATOR","email":"admin@islaplateu.local","password":"Smoke-Test-2026"},cj); sid=[c for c in cj if c.name=="isla_sid"][0].value
    api("POST","/api/admin/restaurants",{"name":"Alpha Grill","municipality":"Larena","category":"Restaurant","address":"Larena","lat":9.2,"lng":123.52},cj)
    def add(set_,name,alt,credit,lic,caption="",rest=""):
        q=urllib.parse.urlencode({"set":set_,"alt":alt,"credit":credit,"license":lic,"caption":caption,"restaurantId":rest,"confirm":"1"})
        return api("POST","/api/admin/slides?"+q,cj=cj,raw=open(f"{D}/{name}.png","rb").read(),ctype="image/png")
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page(w=1280,h=800,reduced=False):
            ctx=b.new_context(viewport={"width":w,"height":h},reduced_motion="reduce" if reduced else "no-preference"); ctx.add_init_script("window.ISLA_SLIDE_MS = 900;")
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else (r.fulfill(status=200,content_type="image/png",body=open(D+"/a.png","rb").read()) if "upload.wikimedia.org" in r.request.url else r.abort()))
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg, ctx
        # --- nothing added yet
        pg,_=page(); pg.goto(BASE+"/"); pg.wait_for_selector(".land-hero"); time.sleep(1.2)
        check(pg.locator(".slides").count()==0 and pg.locator(".photo-credit").is_visible(),"with no extra photos the landing page keeps its original background and credit")
        pg.goto(BASE+"/map"); pg.wait_for_selector(".intro"); time.sleep(1.2)
        check(pg.locator(".intro.has-slides").count()==0,"with no food photos the map page heading is unchanged")
        # --- admin adds a photo through the screen
        ap,_=page(); ap.context.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}]); ap.goto(BASE+"/admin"); ap.click("[data-tab=slides]"); ap.locator("#slAdd").wait_for()
        check("Use only genuine photos" in ap.inner_text("#slideRoot") and "Checawey" in ap.inner_text("#slideRoot"),"the admin screen explains the permission rules and lists the built-in credited photo")
        ap.select_option("#slSet","map"); ap.set_input_files("#slFile",D+"/a.png"); ap.click("#slAdd"); ap.locator("#slAlert", has_text="confirm").first.wait_for() if False else None
        ap.locator("#slAlert").wait_for(); check("Tick the box" in ap.inner_text("#slAlert"),"uploading without confirming the right to use the photo is blocked")
        ap.fill("#slAlt","Grilled tuna on a banana leaf"); ap.fill("#slCaption","Grilled tuna"); ap.select_option("#slRest","alpha-grill"); ap.fill("#slCredit","Photo by Maria Santos"); ap.check("#slConfirm"); ap.click("#slAdd")
        ap.locator("#slAlert", has_text="License").first.wait_for() if False else None
        ap.locator("#slAlert").wait_for(); check("Licence" in ap.inner_text("#slAlert") or "licence" in ap.inner_text("#slAlert").lower(),"a missing licence note is refused with a clear message")
        ap.fill("#slLicense","Permission from Alpha Grill, 10 Nov 2026"); ap.click("#slAdd"); ap.locator(".toast", has_text="added to the slideshow").first.wait_for()
        check("Photo by Maria Santos" in ap.inner_text("#slideRoot"),"the new photo appears in the admin list with its credit")
        ap.screenshot(path=SHOTS+"/admin_slides.png",full_page=True)
        add("map","b","Kinilaw in a coconut shell","Own photo, ISLA-PLATEU team","Owned by the project team","Kinilaw")
        add("landing","c","A market stall with fresh fish","Photo by Juan Cruz","CC BY 4.0","Fresh fish")
        add("landing","d","A seaside restaurant at sunset","Photo by Ana Reyes","CC BY-SA 4.0")
        # --- landing slideshow
        pg,_=page(); pg.goto(BASE+"/"); pg.locator(".land-hero.has-slides").wait_for(); pg.locator(".slide-credit").wait_for()
        first=pg.inner_text(".slide-credit"); check("Checawey" in first and "CC BY-SA 3.0" in first,"the landing slideshow starts with the built-in photo and shows its credit and licence")
        pg.wait_for_function("(t) => document.querySelector('.slide-credit').textContent !== t", arg=first, timeout=8000) if False else None
        t0=time.time(); changed=False
        while time.time()-t0<8:
            if pg.inner_text(".slide-credit")!=first: changed=True; break
            time.sleep(0.2)
        check(changed,"the photos change automatically and the credit changes with them")
        shown=pg.inner_text(".slide-credit"); check(any(x in shown for x in ["Juan Cruz","Ana Reyes"]),"a newly uploaded photo's credit appears")
        pg.click(".slide-pause"); check(pg.get_attribute(".slide-pause","aria-pressed")=="true","the pause button pauses the background photos")
        frozen=pg.inner_text(".slide-credit"); time.sleep(2.2); check(pg.inner_text(".slide-credit")==frozen,"while paused the photo stays put")
        pg.click(".slide-pause"); check(pg.get_attribute(".slide-pause","aria-pressed")=="false","…and it can be resumed")
        pg.screenshot(path=SHOTS+"/landing_slides.png")
        check(pg.locator("#guestNav a[href='/login']").is_visible() and pg.locator("#enterBtn").is_visible(),"buttons and navigation remain visible above the photos")
        pg.click("#guestNav a[href='/login']"); pg.wait_for_url("**/login**"); check(True,"…and clickable (the slideshow does not intercept clicks)")
        # --- reduced motion
        rp,rctx=page(reduced=True); rp.goto(BASE+"/"); rp.locator(".land-hero.has-slides").wait_for()
        dur=rp.evaluate("() => getComputedStyle(document.querySelector('.slide-layer')).transitionDuration"); check(float(dur.rstrip("s"))<0.05,"visitors who prefer reduced motion get no fade animation")
        # --- map page banner
        mp,_=page(); mp.goto(BASE+"/map"); mp.locator(".intro.has-slides").wait_for(); mp.locator(".slide-credit").wait_for()
        col=mp.evaluate("() => getComputedStyle(document.querySelector('.intro h1')).color"); check(col=="rgb(255, 255, 255)","map page heading text is white on the dark photo overlay")
        ct=mp.inner_text(".slide-credit"); check(("Maria Santos" in ct or "project team" in ct) and ("Permission from" in ct or "Owned by" in ct),"the map page shows the photo credit and its licence or permission note")
        check(mp.locator("#map").is_visible() and mp.locator(".workspace").is_visible(),"the map stays on the page below the banner")
        mp.screenshot(path=SHOTS+"/map_slides.png")
        # --- mobile
        mm,_=page(390,800); mm.goto(BASE+"/"); mm.locator(".land-hero.has-slides").wait_for(); mm.screenshot(path=SHOTS+"/landing_mobile.png")
        mm.goto(BASE+"/map"); mm.locator(".intro.has-slides").wait_for(); mm.screenshot(path=SHOTS+"/map_mobile.png")
        ow=mm.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"); check(ow,"no sideways scrolling on a phone-sized screen")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
