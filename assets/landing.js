/* Introduction page: shows the right buttons for guests vs signed-in users and a real restaurant count. */
(async function () {
  "use strict";
  const HOME = { CUSTOMER: "/map", RESTAURANT_STAFF: "/staff", ADMINISTRATOR: "/admin" };
  const [me, list] = await Promise.all([ISLA.api("/api/me"), ISLA.api("/api/restaurants")]);
  if (list.ok && Array.isArray(list.data)) document.getElementById("restCount").textContent = list.data.length;
  if (me.ok) {
    document.getElementById("guestNav").classList.add("hidden");
    document.getElementById("userNav").classList.remove("hidden");
    const link = document.getElementById("homeLink");
    link.href = HOME[me.data.user.role];
    link.querySelector("span").textContent = me.data.user.role === "CUSTOMER" ? "My Account" : "My Dashboard";
    if (me.data.user.role === "CUSTOMER") link.href = "/account";
  }
})();
