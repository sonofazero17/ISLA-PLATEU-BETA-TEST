# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/sweep_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, datetime, zlib, struct, urllib.parse
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3953; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT","MAIL_","SMTP_","CAPTCHA_"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Sweep-Test-2026", TRUST_PROXY_HOPS="1")
def png(rgb,w=160,h=100):
    raw=b"".join(b"\x00"+bytes(rgb)*w for _ in range(h))
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    return b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b"")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
ctr=[0]
def api(method,path,body=None,cj=None,raw=None,ctype="application/json"):
    ctr[0]+=1; op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h={"X-Forwarded-For":f"10.6.{ctr[0]>>8}.{ctr[0]&255}"}
    if data is not None: h["Content-Type"]=ctype
    rq=urllib.request.Request(BASE+path,data=data,method=method,headers=h)
    try:
        r=op.open(rq); t=r.read(); return r.status,(json.loads(t) if t[:1] in b"{[" else t)
    except urllib.error.HTTPError as e:
        t=e.read(); return e.code,(json.loads(t) if t[:1] in b"{[" else t)
def login(portal,email,pw):
    cj=http.cookiejar.CookieJar(); s,d=api("POST","/api/login",{"portal":portal,"email":email,"password":pw},cj); assert s==200,(s,d)
    return cj,[c for c in cj if c.name=="isla_sid"][0].value
issues=[]; checked=[0]
try:
    acj,asid=login("ADMINISTRATOR","admin@islaplateu.local","Sweep-Test-2026")
    api("POST","/api/admin/restaurants",{"name":"Alpha Grill","municipality":"Larena","category":"Restaurant","address":"Larena","acceptsReservations":True,"lat":9.2,"lng":123.52,"hours":"10:00 AM - 9:00 PM"},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Alpha Staff","email":"alpha@example.com","restaurantId":"alpha-grill"},acj); scj,ssid=login("RESTAURANT_STAFF","alpha@example.com",d["temporaryPassword"])
    api("POST","/api/staff/restaurant/logo",cj=scj,raw=png((200,90,40)),ctype="image/png"); api("POST","/api/staff/restaurant/cover",cj=scj,raw=png((40,140,90),320,140),ctype="image/png")
    s,t1=api("POST","/api/staff/menu",{"name":"Grilled Tuna","price":250,"category":"Seafood","description":"Fresh catch"},scj); api("POST",f"/api/staff/menu/{t1['id']}/image",cj=scj,raw=png((60,90,200)),ctype="image/png")
    api("PATCH","/api/staff/restaurant",{"acceptsOrders":True,"orderDineIn":True},scj); api("POST","/api/staff/tables/bulk",{"count":3,"capacity":4},scj)
    api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567"},scj); api("POST","/api/staff/payment-account/qr",cj=scj,raw=png((20,20,20)),ctype="image/png"); api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567","orderPrepay":True,"reservationFee":50},scj)
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"}); ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    day=(datetime.date.today()+datetime.timedelta(days=3)).isoformat()
    s,o=api("POST","/api/orders",{"restaurantId":"alpha-grill","pickupDate":day,"pickupTime":"12:00","items":[{"menuItemId":t1["id"],"qty":1}]},ccj)
    api("POST",f"/api/payments/{o['paymentId']}/proof?reference=SWEEP000001&amount=250",cj=ccj,raw=png((9,9,9)),ctype="image/png")
    api("POST","/api/reservations",{"restaurantId":"alpha-grill","date":day,"time":"19:00","partySize":2},ccj)
    for set_,c in (("landing",(190,160,40)),("map",(150,60,60))):
        q=urllib.parse.urlencode({"set":set_,"alt":"Sample "+set_,"credit":"Sweep test","license":"Own","confirm":"1"}); api("POST","/api/admin/slides?"+q,cj=acj,raw=png(c,320,200),ctype="image/png")
    api("POST","/api/admin/fee-settings",{"kind":"SERVICE_FEE","label":"Service fee","calc":"PERCENT","value":5,"base":"FOOD","appliesTo":"BOTH"},acj)
    loc=api("POST","/api/staff/location-requests",{"lat":9.2,"lng":123.5,"address":"Poblacion, Larena","contactPhone":"0917 123 4567","businessContact":"x"},scj)[1]["id"]
    for k in ("DTI_SEC","STOREFRONT_PHOTO","AUTHORIZATION"): api("POST",f"/api/staff/location-requests/{loc}/documents?kind={k}&name=f.png",cj=scj,raw=png((5,5,5)),ctype="application/octet-stream")
    api("POST",f"/api/staff/location-requests/{loc}/submit",{},scj)
    for e in ("pia@example.com",): api("POST","/api/staff-applications",{"fullName":"Pia","email":e,"contactNumber":"09171234567","password":"Island2026","confirmPassword":"Island2026","restaurantMode":"new","restaurantName":"Pia Grill","restaurantContact":"09181234567","restaurantAddress":"Poblacion, Larena","municipality":"Larena","barangay":"Poblacion","category":"Restaurant","description":"A small grill serving local dishes.","position":"Owner","permitNumber":"BP-1","note":""})
    PAGES=[("guest","/","landing"),("guest","/map","map"),("guest","/login","login"),("guest","/register","register"),("guest","/register-staff","register-staff"),("customer","/account","account"),("customer","/map","map-customer"),("staff","/staff","staff"),("admin","/admin","admin")]
    SID={"customer":csid,"staff":ssid,"admin":asid}
    with sync_playwright() as p:
        b=p.chromium.launch()
        for vw,vh,name in ((1280,900,"desktop"),(768,1000,"tablet"),(390,800,"phone")):
            for role,path,label in PAGES:
                ctx=b.new_context(viewport={"width":vw,"height":vh},extra_http_headers={"X-Forwarded-For":f"10.5.{vw%250}.{len(label)}"})
                if role!="guest": ctx.add_cookies([{"name":"isla_sid","value":SID[role],"domain":"localhost","path":"/"}])
                pg=ctx.new_page(); bad=[]
                pg.on("pageerror",lambda e,l=f"{name}:{label}": issues.append(f"{l}: JS error {e}"))
                pg.on("console",lambda m,l=f"{name}:{label}": issues.append(f"{l}: console {m.text[:100]}") if ("Refused" in m.text or "Content Security" in m.text) else None)
                pg.on("response",lambda r,l=f"{name}:{label}": issues.append(f"{l}: {r.status} {r.url.replace(BASE,'')}") if (r.url.startswith(BASE) and r.status>=400 and r.status not in (401,) and "/api/me" not in r.url) else None)
                pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
                pg.goto(BASE+path); pg.wait_for_load_state("networkidle"); time.sleep(0.6)
                def audit(tag):
                    checked[0]+=1
                    res=pg.evaluate("""() => { window.scrollTo(0, document.body.scrollHeight); const out = {};
                      out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
                      out.broken = [...document.images].filter(i => i.src.startsWith(location.origin) && i.complete && i.naturalWidth === 0).map(i => i.src.replace(location.origin, ''));
                      out.noalt = [...document.images].filter(i => !i.hasAttribute('alt')).length;
                      out.lang = !!document.documentElement.lang; out.title = !!document.title.trim(); out.h1 = document.querySelectorAll('h1').length;
                      out.unlabeled = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')].filter(e => e.offsetParent !== null && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.closest('label')).map(e => (e.name || e.id || e.type)).slice(0, 5);
                      out.tiny = [...document.querySelectorAll('button, a.btn')].filter(e => e.offsetParent !== null && e.textContent.trim() === '' && !e.getAttribute('aria-label') && !e.title && !e.querySelector('svg, img, [data-lucide]')).length;
                      return out; }""")
                    lbl=f"{name}:{label}{tag}"
                    if res["overflow"]: issues.append(f"{lbl}: sideways scrolling")
                    if res["broken"]: issues.append(f"{lbl}: broken images {res['broken'][:3]}")
                    if res["noalt"]: issues.append(f"{lbl}: {res['noalt']} images without alt")
                    if not res["lang"] or not res["title"]: issues.append(f"{lbl}: missing lang/title")
                    if res["h1"]!=1: issues.append(f"{lbl}: {res['h1']} h1 headings")
                    if res["unlabeled"]: issues.append(f"{lbl}: unlabelled fields {res['unlabeled']}")
                    if res["tiny"]: issues.append(f"{lbl}: {res['tiny']} buttons with no accessible name")
                audit("")
                if label in ("staff","admin","account"):
                    tabs=pg.locator(".tabs .tab"); n=tabs.count()
                    for i in range(n):
                        tabs.nth(i).click(); time.sleep(0.5); pg.wait_for_load_state("networkidle"); audit(f"/tab{i}")
                if label=="landing": pg.screenshot(path=SHOTS+f"/sweep_{name}_landing.png")
                if label=="map" and name=="phone": pg.screenshot(path=SHOTS+f"/sweep_phone_map.png")
                if label=="admin" and name=="phone": pg.screenshot(path=SHOTS+f"/sweep_phone_admin.png")
                if label=="staff" and name=="phone": pg.screenshot(path=SHOTS+f"/sweep_phone_staff.png")
                ctx.close()
        b.close()
finally:
    srv.kill()
print("page states checked:",checked[0])
seen=set(); 
for i in issues:
    if i not in seen: seen.add(i); print("ISSUE",i)
print("issues:",len(seen))
