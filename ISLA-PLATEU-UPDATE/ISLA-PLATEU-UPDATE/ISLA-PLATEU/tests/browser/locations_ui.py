# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/locations_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, sys
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3944; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
time.sleep(2.5)
def api(method,path,body=None,cj=None,raw=None,ctype="application/json"):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    rq=urllib.request.Request(BASE+path,data=data,method=method,headers={"Content-Type":ctype} if data is not None else {})
    try:
        r=op.open(rq); t=r.read(); return r.status, (json.loads(t) if t[:1] in b"{[" else t)
    except urllib.error.HTTPError as e:
        t=e.read(); return e.code, (json.loads(t) if t[:1] in b"{[" else t)
def login(portal,email,pw):
    cj=http.cookiejar.CookieJar(); s,d=api("POST","/api/login",{"portal":portal,"email":email,"password":pw},cj); assert s==200,(s,d)
    return cj,[c for c in cj if c.name=="isla_sid"][0].value
errors=[]; results=[]
def check(c,name): results.append((c,name)); print(("PASS " if c else "FAIL ")+name)
try:
    acj,asid=login("ADMINISTRATOR","admin@islaplateu.local","Smoke-Test-2026")
    api("POST","/api/admin/restaurants",{"name":"Smoke Grill","municipality":"Larena","category":"Restaurant","address":"Larena"},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Smoke Staff","email":"smoke@example.com","restaurantId":"smoke-grill"},acj)
    scj,ssid=login("RESTAURANT_STAFF","smoke@example.com",d["temporaryPassword"])
    s,d=api("POST","/api/staff/location-requests",{"lat":9.2,"lng":123.52,"address":"Poblacion, Larena","contactPhone":"0917 123 4567","businessContact":"x@example.com"},scj); rid=d["id"]
    open(D+"/front.png","wb").write(b"\x89PNG\r\n\x1a\n"+b"1"*300); open(D+"/permit.pdf","wb").write(b"%PDF-1.4\n"+b"A"*300); open(D+"/auth.png","wb").write(b"\x89PNG\r\n\x1a\n"+b"2"*300)
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page_for(sid,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h}); ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append(str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); pg.on("dialog",lambda d:d.accept()); return pg
        pg=page_for(ssid); pg.goto(BASE+"/staff"); pg.wait_for_selector("[data-tab=location]")
        pg.click("[data-tab=location]"); pg.wait_for_selector("#locRoot .card")
        txt=pg.inner_text("#locRoot")
        check("does not have an approved map location" in txt,"staff tab explains no approved location yet")
        check("Draft" in txt and "Supporting evidence" in txt and "Pinned: 9.2, 123.52" in txt,"draft request shows pin, details and evidence section")
        pg.screenshot(path=SHOTS+"/staff_loc_desktop.png",full_page=True)
        for kind,f in [("STOREFRONT_PHOTO","front.png"),("MAYORS_PERMIT","permit.pdf"),("AUTHORIZATION","auth.png")]:
            pg.set_input_files(f"input[data-doc-kind={kind}]",D+"/"+f); pg.locator(".item-card", has=pg.locator(f"input[data-doc-kind={kind}]")).locator("a").wait_for()
        check(pg.locator("#locRoot .item-card a").count()==3,"three documents uploaded through the UI")
        pg.click("[data-loc-submit]"); pg.wait_for_selector("dialog[open] [data-yes], .modal [data-yes]"); pg.click("[data-yes]")
        pg.locator("#locRoot", has_text="cannot edit it while").wait_for()
        check("cannot edit it while it is being reviewed" in pg.inner_text("#locRoot"),"after submit the staff view is read-only with status Pending")
        pg.set_viewport_size({"width":390,"height":800}); pg.screenshot(path=SHOTS+"/staff_loc_mobile.png",full_page=True)
        # admin
        ap=page_for(asid); ap.goto(BASE+"/admin"); ap.wait_for_selector("[data-tab=locations]")
        ap.locator("#cLoc").wait_for(state="visible")
        check(ap.inner_text("#cLoc")=="1","admin tab badge shows 1 pending request")
        ap.click("[data-tab=locations]"); ap.wait_for_selector("[data-loc-review]"); ap.screenshot(path=SHOTS+"/admin_locations.png")
        ap.click("[data-loc-review]"); ap.wait_for_selector("[data-dec=APPROVED]")
        mt=ap.inner_text(".modal, dialog[open]")
        check("Smoke Grill" in mt and "Mayor" in mt and "Storefront" in mt and "9.2, 123.52" in mt,"admin review modal shows pin, profile and evidence")
        ap.screenshot(path=SHOTS+"/admin_review.png",full_page=True)
        ap.click("[data-dec=APPROVED]"); ap.wait_for_selector("[data-yes]"); ap.click("[data-yes]")
        ap.locator("[data-dec=APPROVED]").wait_for(state="detached")
        ap.click("[data-tab=audit]"); ap.wait_for_selector("#auditRoot table")
        check("location_request.approved" in ap.inner_text("#auditRoot"),"audit log tab shows the approval")
        s,d=api("GET","/api/restaurants/smoke-grill"); check(d["restaurant"]["lat"]==9.2 and d["restaurant"]["locationStatus"]=="verified","approval published the pin")
        pg.set_viewport_size({"width":1280,"height":900}); pg.click("[data-tab=reservations]"); pg.click("[data-tab=location]"); pg.locator("#locRoot", has_text="Approved pin").wait_for()
        check("Request a different location" in pg.inner_text("#locRoot"),"staff sees approved pin and can request a new location")
        b.close()
finally:
    srv.kill()
bad=[e for e in errors]
print("JS page errors:",bad)
check(not bad,"no JavaScript errors on staff/admin pages")
print(f"\n{sum(1 for c,_ in results if c)} passed, {sum(1 for c,_ in results if not c)} failed")
