/* Background slideshows. The map uses a locally rendered, moving food-photo collage. */
(function () {
  "use strict";
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const INTERVAL = Number(window.ISLA_SLIDE_MS) || 7000;
  const SAFE = (u) => typeof u === "string" && (u.startsWith("/uploads/public/") || u.startsWith("/assets/images/locator-slideshow/") || u.startsWith("/assets/images/restaurant-slides/") || u === "/assets/dagsa-resto/dagsa-interior-cover.jpg" || u.startsWith("https://upload.wikimedia.org/"));
  const LOCAL_MAP_SLIDES = [
    { url: "/assets/images/locator-slideshow/seafood-sharing-platter.jpg", alt: "Grilled fish and shrimp with citrus and dipping sauce", caption: "Seafood inspired by island flavors", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/grilled-fish-calamansi.jpg", alt: "Grilled fish served with rice, dipping sauce and calamansi", caption: "Freshly grilled island fish", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/mango-coconut-smoothie-bowl.jpg", alt: "Mango, banana and granola smoothie bowl", caption: "A tropical smoothie bowl", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/island-cheeseburger.jpg", alt: "Cheeseburger with lettuce, tomato and fries", caption: "Island-style comfort food", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/mango-cheesecake.jpg", alt: "Mango-topped cheesecake on a plate", caption: "A sweet mango dessert", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/chicken-buffalo-wings.jpg", alt: "Buffalo chicken wings served with rice", caption: "A Filipino-style rice meal", credit: "ISLA-PLATEU demo imagery" },
    { url: "/assets/images/locator-slideshow/calamansi-citrus-cooler.jpg", alt: "Iced calamansi citrus drink with fresh fruit", caption: "A cool calamansi refreshment", credit: "ISLA-PLATEU demo imagery" }
  ];
  const LOCAL_LANDING_PLACEHOLDERS = [
    { id: "dagsa-resto", name: "Dagsa Resto Bar", url: "/assets/images/restaurant-slides/placeholder-dagsa.svg" },
    { id: "pagudfood", name: "PagudFood Cafe", url: "/assets/images/restaurant-slides/placeholder-pagudfood.svg" },
    { id: "the-cafe-infinite", name: "The Cafe Infinite", url: "/assets/images/restaurant-slides/placeholder-cafe-infinite.svg" },
    { id: "la-candura", name: "La Candura", url: "/assets/images/restaurant-slides/placeholder-la-candura.svg" },
    { id: "luka-loko", name: "Luca Loko Restaurant", url: "/assets/images/restaurant-slides/placeholder-luca-loko.svg" }
  ];
  const LOCAL_LANDING_VENUE_PHOTOS = new Map([
    ["dagsa-resto", { url: "/assets/dagsa-resto/dagsa-interior-cover.jpg" }],
    ["the-cafe-infinite", {
      url: "/assets/images/restaurant-slides/cafe-infinite-exterior.jpg",
      credit: "Facebook · almystery2017",
      sourceUrl: "https://www.facebook.com/almystery2017/posts/%EF%B8%8F-newly-opened-industrial-cafe-in-siquijor-i-went-to-cafe-infinite-siquijor-the-/952957663652847/"
    }],
    ["pagudfood", {
      url: "/assets/images/restaurant-slides/pagudfood-interior.jpg",
      credit: "Isla Bites via Facebook",
      sourceUrl: "https://www.facebook.com/photo.php?fbid=122109321315513728&set=a.122106202713513728&type=3"
    }],
    ["luka-loko", {
      url: "/assets/images/restaurant-slides/luca-loko-exterior.jpg",
      credit: "Siquijor Directory",
      sourceUrl: "https://siquijordirectory.com/lucaloko/"
    }],
    ["la-candura", {
      url: "/assets/images/restaurant-slides/la-candura-exterior.jpg",
      credit: "Booking.com · La Candura",
      sourceUrl: "https://www.booking.com/hotel/ph/la-candura.html"
    }]
  ]);
  const VENUE_PHOTO_DESCRIPTION = /\b(interior|exterior|building|entrance|facade|storefront|dining room|dining area|seating area|restaurant sign|cafe sign|café sign|patio)\b/i;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const loadImage = (url) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });

  function roundedPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawPhotoTile(ctx, image, x, y, width, height) {
    ctx.save();
    roundedPath(ctx, x, y, width, height, 20);
    ctx.fillStyle = "#FFFFFF";
    ctx.shadowColor = "rgba(31, 35, 29, .3)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 5;
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedPath(ctx, x, y, width, height, 20);
    ctx.clip();
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const cropWidth = width / scale, cropHeight = height / scale;
    const cropX = (image.naturalWidth - cropWidth) / 2, cropY = (image.naturalHeight - cropHeight) / 2;
    ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
    ctx.restore();
  }

  async function createCollage(photos) {
    const loaded = [];
    for (const photo of photos) {
      const image = await loadImage(photo.url);
      if (image) loaded.push({ photo, image });
    }
    if (!loaded.length) return null;

    const width = 1600, height = 1200, tileHeight = 282, gap = 16;
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#F2EDE4"; ctx.fillRect(0, 0, width, height);
    const rows = [
      { y: 18, offset: 0, tiles: [[520, 0], [300, 1], [360, 2], [372, 3]] },
      { y: 318, offset: 32, tiles: [[280, 4], [400, 5], [300, 6], [280, 0], [276, 1]] },
      { y: 618, offset: -24, tiles: [[420, 2], [260, 3], [500, 4], [372, 5]] },
      { y: 918, offset: 0, tiles: [[520, 0], [300, 1], [360, 2], [372, 3]] }
    ];

    for (const row of rows) {
      for (let repeatX = -width; repeatX <= width; repeatX += width) {
        let x = repeatX - row.offset;
        for (const [tileWidth, photoIndex] of row.tiles) {
          drawPhotoTile(ctx, loaded[photoIndex % loaded.length].image, x, row.y, tileWidth, tileHeight);
          x += tileWidth + gap;
        }
      }
    }
    try {
      const texture = canvas.toDataURL("image/jpeg", 0.82);
      canvas.width = 0; canvas.height = 0;
      return { texture, loaded };
    } catch (error) {
      console.warn("Could not render the local food-photo collage.", error);
      return null;
    }
  }

  function appendCredits(host, loaded) {
    const seen = new Set();
    const unique = loaded.filter(({ photo }) => {
      const key = [photo.credit || "", photo.license || "", photo.sourceUrl || ""].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const details = el("details", "slide-credit");
    const summaryText = unique.length === 1 ? `Photo: ${unique[0].photo.credit}` : `Photo credits (${unique.length})`;
    details.appendChild(el("summary", "", summaryText));
    const list = el("span", "slide-credit-list");
    for (const { photo } of unique) {
      const item = el("span", "slide-credit-item");
      if (/^https?:\/\//.test(photo.sourceUrl || "")) {
        const link = el("a", "", photo.credit || "Photo source");
        link.href = photo.sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.appendChild(link);
      } else {
        item.append(photo.credit || "ISLA-PLATEU demo imagery");
      }
      if (photo.license) item.append(` · ${photo.license}`);
      list.appendChild(item);
    }
    details.appendChild(list);
    host.appendChild(details);
  }

  async function startMapCollage(host, apiSlides) {
    const photos = apiSlides.filter(photo => photo.url.startsWith("/uploads/public/")).slice(0, 7);
    const used = new Set(photos.map(photo => photo.url));
    for (const photo of LOCAL_MAP_SLIDES) {
      if (photos.length >= 7) break;
      if (!used.has(photo.url)) photos.push(photo);
    }

    let collage = await createCollage(photos);
    if (!collage && photos.some(photo => photo.url.startsWith("/uploads/public/"))) {
      collage = await createCollage(LOCAL_MAP_SLIDES);
    }
    if (!collage) return;

    const background = el("div", "food-collage");
    background.setAttribute("aria-hidden", "true");
    background.style.backgroundImage = `url("${collage.texture}")`;
    host.prepend(background);
    host.classList.add("has-collage");

    const intro = host.querySelector(".intro") || host;
    intro.classList.add("slide-info-host");
    const meta = el("div", "slide-meta");
    const pause = el("button", "slide-pause");
    pause.type = "button";
    pause.setAttribute("aria-label", "Pause background photos");
    pause.setAttribute("aria-pressed", "false");
    pause.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path class="p-pause" d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/><path class="p-play" d="M8 5l11 7-11 7z" fill="currentColor" style="display:none"/></svg>';
    const left = el("span", "slide-left");
    left.append(pause, el("span", "slide-caption", "Island flavors, in a moving photo collage"));
    meta.append(left);
    appendCredits(meta, collage.loaded);
    intro.appendChild(meta);

    if (reduce) {
      pause.remove();
    } else {
      let paused = false;
      const syncMotion = () => background.classList.toggle("is-paused", paused || document.hidden);
      pause.addEventListener("click", () => {
        paused = !paused;
        pause.setAttribute("aria-pressed", String(paused));
        pause.setAttribute("aria-label", paused ? "Play background photos" : "Pause background photos");
        pause.querySelector(".p-pause").style.display = paused ? "none" : "";
        pause.querySelector(".p-play").style.display = paused ? "" : "none";
        syncMotion();
      });
      document.addEventListener("visibilitychange", syncMotion);
      syncMotion();
    }
  }

  async function startLanding(host, slides) {
    const namesToIds = new Map(LOCAL_LANDING_PLACEHOLDERS.map(restaurant => [restaurant.name.toLowerCase(), restaurant.id]));
    const savedById = new Map();
    for (const slide of slides) {
      if (slide.isPlaceholder || !VENUE_PHOTO_DESCRIPTION.test(`${slide.alt || ""} ${slide.caption || ""} ${slide.title || ""}`)) continue;
      const id = slide.restaurantId || namesToIds.get(String(slide.restaurantName || "").toLowerCase());
      if (!id || !LOCAL_LANDING_PLACEHOLDERS.some(restaurant => restaurant.id === id)) continue;
      if (!savedById.has(id) || (savedById.get(id).isPlaceholder && !slide.isPlaceholder)) savedById.set(id, slide);
    }
    const backgrounds = LOCAL_LANDING_PLACEHOLDERS.map(restaurant => {
      const saved = savedById.get(restaurant.id);
      if (saved && SAFE(saved.url)) return saved;
      const venuePhoto = LOCAL_LANDING_VENUE_PHOTOS.get(restaurant.id);
      return venuePhoto ? { ...restaurant, ...venuePhoto } : { ...restaurant, isPlaceholder: true };
    });
    for (let i = backgrounds.length - 1; i >= 0; i--) {
      if (await loadImage(backgrounds[i].url)) continue;
      const placeholder = LOCAL_LANDING_PLACEHOLDERS.find(restaurant => restaurant.id === backgrounds[i].id);
      if (placeholder && await loadImage(placeholder.url)) backgrounds[i] = placeholder;
      else backgrounds.splice(i, 1);
    }
    if (!backgrounds.length) return;

    const wrap = el("div", "slides");
    wrap.setAttribute("aria-hidden", "true");
    const layers = [el("div", "slide-layer"), el("div", "slide-layer")];
    layers.forEach(layer => wrap.appendChild(layer));
    host.prepend(wrap);
    host.classList.add("has-slides");
    let index = 0, front = 0;
    const credit = host.querySelector(".photo-credit");
    const show = (next) => {
      index = next % backgrounds.length;
      const photo = backgrounds[index];
      const incoming = layers[1 - front];
      incoming.style.backgroundImage = `url("${photo.url}")`;
      incoming.classList.add("on");
      layers[front].classList.remove("on");
      front = 1 - front;
      const hasCreditLink = credit && photo.credit && /^https:\/\//i.test(photo.sourceUrl || "");
      if (credit) {
        credit.style.display = hasCreditLink ? "block" : "";
        if (hasCreditLink) {
          credit.href = photo.sourceUrl;
          credit.target = "_blank";
          credit.rel = "noopener noreferrer";
          credit.textContent = `Photo: ${photo.credit} · used with permission`;
        }
      }
    };
    show(0);
    if (backgrounds.length > 1 && !reduce) {
      setInterval(() => { if (!document.hidden) show(index + 1); }, INTERVAL);
    }
  }

  async function start(host) {
    const set = host.dataset.slideshow;
    let slides = [];
    try {
      const response = await fetch(`/api/slides?set=${encodeURIComponent(set)}`, { credentials: "same-origin" });
      if (!response.ok) {
        if (set !== "map") return;
        console.warn(`Map slideshow API returned ${response.status}; using local photos.`);
      } else {
        const data = await response.json();
        slides = (Array.isArray(data.slides) ? data.slides : []).filter(photo => SAFE(photo.url));
      }
    } catch (error) {
      if (set !== "map") return;
      console.warn("Map slideshow API unavailable; using local photos.", error);
    }
    if (set === "map") {
      await startMapCollage(host, slides);
      return;
    }
    await startLanding(host, slides);
  }
  const run = () => document.querySelectorAll("[data-slideshow]").forEach(start);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
