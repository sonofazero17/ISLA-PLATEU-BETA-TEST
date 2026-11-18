# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/tables_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3946; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
def api(method,path,body=None,cj=None):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    rq=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={"Content-Type":"application/json"} if body is not None else {})
    try:
        r=op.open(rq); t=r.read(); return r.status,(json.loads(t) if t[:1] in b"{[" else t)
    except urllib.error.HTTPError as e:
        t=e.read(); return e.code,(json.loads(t) if t[:1] in b"{[" else t)
def login(portal,email,pw):
    cj=http.cookiejar.CookieJar(); s,d=api("POST","/api/login",{"portal":portal,"email":email,"password":pw},cj); assert s==200,(s,d)
    return cj,[c for c in cj if c.name=="isla_sid"][0].value
errors=[]; results=[]
def check(c,name): results.append(c); print(("PASS " if c else "FAIL ")+name)
try:
    acj,asid=login("ADMINISTRATOR","admin@islaplateu.local","Smoke-Test-2026")
    api("POST","/api/admin/restaurants",{"name":"Table Test Grill","municipality":"Larena","category":"Restaurant","address":"Larena","acceptsReservations":True,"lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Tbl Staff","email":"tbl@example.com","restaurantId":"table-test-grill"},acj)
    scj,ssid=login("RESTAURANT_STAFF","tbl@example.com",d["temporaryPassword"])
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"})
    ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page_for(sid,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h}); ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        sp=page_for(ssid); sp.goto(BASE+"/staff"); sp.wait_for_selector("[data-tab=tables]"); sp.click("[data-tab=tables]")
        sp.locator("#tblRoot", has_text="not added any tables").wait_for()
        sp.fill("#tbCount","3"); sp.fill("#tbSeats","4"); sp.click("#tbBulk button[type=submit]")
        sp.locator("tr[data-trow]").nth(2).wait_for()
        check(sp.locator("tr[data-trow]").count()==3,"staff bulk-adds three tables through the UI")
        sp.fill("#tbName","Window 1"); sp.fill("#tbOneSeats","2"); sp.click("#tbOne button[type=submit]")
        sp.locator("tr[data-trow]").nth(3).wait_for()
        row=sp.locator("tr[data-trow]").nth(3); row.locator("[data-f=capacity]").fill("3"); row.locator("[data-tb-save]").click()
        sp.locator("#toasts, .toast", has_text="Table saved").first.wait_for()
        check(sp.locator("tr[data-trow]").nth(3).locator("[data-f=capacity]").input_value()=="3","staff edits a table's seats and saves")
        sp.screenshot(path=SHOTS+"/staff_tables.png",full_page=True)
        # customer
        cp=page_for(csid); cp.goto(BASE+"/map"); cp.wait_for_load_state("networkidle")
        card=cp.locator("text=Table Test Grill").first; card.wait_for(timeout=8000)
        check(True,"customer map page lists the restaurant offline (no map tiles)")
        cp.locator("[data-details=table-test-grill]").click()
        cp.locator("h3.detail-h", has_text="Tables").wait_for(timeout=8000)
        cp.locator(".table-chip").first.wait_for()
        check(cp.locator(".table-chip").count()==4,"details panel shows a chip per table with seats and status")
        cp.screenshot(path=SHOTS+"/customer_tables_details.png",full_page=True)
        cp.click("[data-act=reserve]"); cp.wait_for_selector("#rvDate")
        import datetime
        d=(datetime.date.today()+datetime.timedelta(days=3)).isoformat()
        cp.fill("#rvDate",d); cp.fill("#rvTime","19:00"); cp.fill("#rvParty","3")
        cp.locator("input[name=rvTable]").nth(1).wait_for()
        labels=cp.locator(".table-pick label").all_inner_texts()
        check(any("Window 1" in t and "seats 3" in t for t in labels) and any("Table 1" in t for t in labels),"reserve dialog lists the tables that are free")
        cp.fill("#rvParty","6"); cp.locator("text=No table is free for 6 guests").wait_for()
        check(True,"party too large for every table shows a clear message")
        cp.fill("#rvParty","3"); cp.locator("input[name=rvTable]").nth(1).wait_for()
        cp.locator(".table-pick label", has_text="Table 2").locator("input").check()
        cp.screenshot(path=SHOTS+"/customer_reserve_dialog.png")
        cp.click("[data-yes]"); cp.locator(".toast", has_text="Reservation request sent").first.wait_for()
        check(True,"customer sends a request for a specific table")
        sp.click("[data-tab=reservations]"); sp.reload(); sp.wait_for_selector("[data-tab=reservations]")
        sel=sp.locator("select[data-res-table]"); sel.wait_for()
        check("requested by customer" in sel.inner_text(),"staff sees the pending request with the customer's table preselected")
        sp.click("[data-status=CONFIRMED]"); sp.locator(".toast", has_text="Table: Table 2").first.wait_for()
        check(True,"staff confirms and the assigned table is reported")
        s,dd=api("GET",f"/api/restaurants/table-test-grill/tables?date={d}&time=19:30")
        check(dd["summary"]["reserved"]==1 and dd["summary"]["available"]==3,"availability updated: 1 reserved, 3 free")
        ap=page_for(csid); ap.goto(BASE+"/account"); ap.locator("#resList", has_text="Table 2").wait_for()
        check(True,"customer's account shows the assigned table")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
