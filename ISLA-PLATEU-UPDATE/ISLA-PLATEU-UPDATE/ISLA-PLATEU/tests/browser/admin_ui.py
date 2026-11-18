# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/admin_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, datetime, sqlite3
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3952; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT","MAIL_","SMTP_","CAPTCHA_"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026", TRUST_PROXY_HOPS="1")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
PNG=lambda n: b"\x89PNG\r\n\x1a\n"+bytes([n])*200
ctr=[0]
def api(method,path,body=None,cj=None,raw=None,ctype="application/json"):
    ctr[0]+=1; op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h={"X-Forwarded-For":f"10.8.{ctr[0]>>8}.{ctr[0]&255}"}; 
    if data is not None: h["Content-Type"]=ctype
    rq=urllib.request.Request(BASE+path,data=data,method=method,headers=h)
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
    api("POST","/api/admin/restaurants",{"name":"Alpha Grill","municipality":"Larena","category":"Restaurant","address":"Larena","acceptsReservations":True,"lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Alpha Staff","email":"alpha@example.com","restaurantId":"alpha-grill"},acj); scj,_=login("RESTAURANT_STAFF","alpha@example.com",d["temporaryPassword"])
    s,t1=api("POST","/api/staff/menu",{"name":"Grilled Tuna","price":200,"category":"Main dish"},scj); api("POST",f"/api/staff/menu/{t1['id']}/image",cj=scj,raw=PNG(1),ctype="image/png")
    api("PATCH","/api/staff/restaurant",{"acceptsOrders":True},scj); api("POST","/api/staff/tables/bulk",{"count":3,"capacity":4},scj)
    api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567"},scj); api("POST","/api/staff/payment-account/qr",cj=scj,raw=PNG(2),ctype="image/png")
    api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567","orderPrepay":True,"reservationFee":0},scj)
    api("POST","/api/staff/restaurant/logo",cj=scj,raw=PNG(3),ctype="image/png")
    for n in ("cara","dan"): api("POST","/api/register",{"fullName":n.title()+" Customer","email":n+"@example.com","password":"Island2026","confirmPassword":"Island2026"})
    c1,_=login("CUSTOMER","cara@example.com","Island2026"); c2,_=login("CUSTOMER","dan@example.com","Island2026")
    day=(datetime.date.today()+datetime.timedelta(days=3)).isoformat()
    s,o=api("POST","/api/orders",{"restaurantId":"alpha-grill","pickupDate":day,"pickupTime":"12:00","items":[{"menuItemId":t1["id"],"qty":2}]},c1)
    api("POST",f"/api/payments/{o['paymentId']}/proof?reference=UIREF0001&amount=400",cj=c1,raw=PNG(10),ctype="image/png")
    for tm in ("18:00","19:00","20:00"): api("POST","/api/reservations",{"restaurantId":"alpha-grill","date":day,"time":tm,"partySize":2},c1 if tm!="19:00" else c2)
    s,rr=api("GET","/api/staff/reservations",cj=scj); api("PATCH",f"/api/staff/reservations/{rr[0]['id']}",{"status":"CONFIRMED"},scj)
    db=sqlite3.connect(D+"/t.db"); db.execute("UPDATE payment_submissions SET created_at = datetime('now','-30 hours')"); db.execute("UPDATE users SET verification_required=1 WHERE email='cara@example.com'"); db.commit(); db.close()
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page(w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h},extra_http_headers={"X-Forwarded-For":"10.9.9.%d"%(w%200)}); ctx.add_cookies([{"name":"isla_sid","value":asid,"domain":"localhost","path":"/"}]); pg=ctx.new_page()
            pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        ap=page(); ap.goto(BASE+"/admin")
        ap.locator("#overviewRoot .card", has_text="Needs your attention").wait_for()
        t=ap.inner_text("#overviewRoot")
        check("Payment receipts the restaurant has not checked for over 24 hours" in t and "waiting to verify" in t,"the overview opens with a 'needs your attention' list built from real counts")
        ap.locator("#overviewRoot [data-goto=monitor][data-sub=payments]").first.click(); ap.locator("[data-mon-sub=payments][aria-pressed=true]").wait_for()
        check(True,"an attention item opens the right monitoring view")
        ap.locator("#monBody table").wait_for(); pt=ap.inner_text("#monBody")
        check("UIREF0001" in pt and "Not checked for 24h+" in pt and "Only the restaurant can accept" in pt and ap.locator("#monBody a", has_text="view receipt").count()==1,"payments view: reference, the overdue flag, the receipt link and the rule that only restaurants decide")
        ap.screenshot(path=SHOTS+"/admin_monitor_payments.png",full_page=True)
        ap.click("[data-mon-sub=reservations]"); ap.locator("#monBody table tbody tr").nth(2).wait_for()
        check(ap.locator("#monBody table tbody tr").count()==3 and "Dan Customer" in ap.inner_text("#monBody"),"reservations view lists all bookings with customers")
        ap.locator("[data-mon-status=CONFIRMED]").click(); ap.locator("#monBody table tbody tr").nth(0).wait_for(); check(ap.locator("#monBody table tbody tr").count()==1,"clicking a status chip filters the list")
        ap.locator("[data-mon-status=all]").click(); ap.locator("[data-mon-f=q]").fill("dan"); ap.locator("[data-mon-f=q]").press("Enter"); ap.wait_for_timeout(600); check(ap.locator("#monBody table tbody tr").count()==1,"searching by customer name narrows the list")
        ap.click("[data-mon-sub=orders]"); ap.locator("#monBody", has_text="Grilled Tuna").wait_for(); check("2 x Grilled Tuna" in ap.inner_text("#monBody"),"orders view shows the items")
        ap.click("[data-mon-sub=tables]"); ap.locator(".table-chip").first.wait_for(); ap.locator("#monBody", has_text="3 tables, 12 seats").wait_for(); check(ap.locator(".table-chip").count()==3 and "3 tables, 12 seats" in ap.inner_text("#monBody"),"tables view shows live availability per restaurant")
        ap.click("[data-mon-sub=menus]"); ap.locator("[data-menu-open]").first.wait_for(); ap.locator("[data-menu-open]").first.click(); ap.locator("[data-mi-toggle]").wait_for()
        ap.click("[data-mi-toggle]"); ap.locator(".toast", has_text="Done").first.wait_for(); ap.locator("[data-mi-toggle]").wait_for(); ap.locator(".pill", has_text="Hidden").wait_for(); check(True,"an administrator can hide a menu item from the menu view")
        ap.keyboard.press("Escape")
        ap.click("[data-tab=restaurants]"); ap.locator("[data-rest-overview]").first.click(); ap.locator(".modal, dialog[open]").wait_for(); ap.wait_for_timeout(500)
        ot=ap.inner_text(".modal, dialog[open]")
        check("Alpha Grill" in ot and "3 tables" in ot and "GCash" in ot and "Email verified" in ot or "Not verified" in ot,"the restaurant overview gathers profile, staff, tables, menu and payment status")
        check("09171234567" not in ot and "Juan Dela Cruz" not in ot,"…without showing the GCash number or holder name")
        ap.screenshot(path=SHOTS+"/admin_restaurant_overview.png")
        ap.keyboard.press("Escape")
        ap.click("[data-tab=accounts]"); ap.locator("[data-acf=verified]").wait_for(); ap.select_option("[data-acf=verified]","waiting"); ap.wait_for_timeout(700)
        rows=ap.locator("#acctRoot table tbody tr"); check(rows.count()==1 and "Waiting to verify" in rows.first.inner_text(),"the accounts list filters to people still waiting to verify their email")
        ap.locator("[data-send-code]").click(); ap.locator("#modalRoot [data-yes], .modal [data-yes], dialog[open] [data-yes]").first.click(); ap.locator(".toast", has_text="not set up").first.wait_for(); check(True,"asking for a code explains clearly when email delivery is not set up")
        ap.click("[data-tab=audit]"); ap.locator("#auditRoot table tbody tr").first.wait_for(); n0=ap.locator("#auditRoot table tbody tr").count()
        check(n0>3 and "menu_item.hidden" in ap.inner_text("#auditRoot"),"the audit log shows the actions just taken")
        check("/api/admin/audit-export" in ap.get_attribute("#auditRoot a[download]","href"),"an export link is offered")
        ap.select_option("[data-aud=action]","menu_item"); ap.wait_for_timeout(700); check(all("menu_item" in r for r in ap.locator("#auditRoot table tbody tr td:nth-child(3)").all_inner_texts()),"filtering the audit log by action")
        mp=page(390,800); mp.goto(BASE+"/admin"); mp.click("[data-tab=monitor]"); mp.locator("#monBody table").wait_for(); check(mp.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"),"the monitoring screen does not force sideways scrolling on a phone")
        mp.screenshot(path=SHOTS+"/admin_monitor_mobile.png")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
