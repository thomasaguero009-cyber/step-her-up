/* Carrusel de capturas de testimonios (compartido por index, webinar y testimonios).
   Autoplay infinito con zona de clones, arrastre (mouse y dedo), flechas, teclado,
   trackpad horizontal y zoom en el lugar al tocar una captura. Necesita #carouselTrack con las
   slides reales seguidas de 3 clones de las primeras. */
(function () {
  var track = document.getElementById("carouselTrack");
  if (!track) return;
  var carousel = track.parentElement;

  var CLONE_COUNT = 3;
  var totalSlides = track.children.length;
  var realSlides = totalSlides - CLONE_COUNT;
  var AUTOPLAY_MS = 3200;
  var RESUME_AFTER_TOUCH_MS = 12000; // tras tocar/arrastrar/usar flechas: tiempo para mirar con calma
  var RESUME_AFTER_LEAVE_MS = 6000;  // tras sacar el mouse de encima

  var index = 0;
  var autoplayTimer = null, resumeTimer = null, bridgeResetHandler = null;
  var hovering = false;

  // ----- Estructura: flechas alrededor del carrusel -----
  var wrap = document.createElement("div");
  wrap.className = "carousel-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Capturas de testimonios");
  var svgIzq = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  var svgDer = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
  var prevBtn = document.createElement("button");
  prevBtn.type = "button"; prevBtn.className = "carousel-arrow carousel-prev"; prevBtn.setAttribute("aria-label", "Anterior"); prevBtn.innerHTML = svgIzq;
  var nextBtn = document.createElement("button");
  nextBtn.type = "button"; nextBtn.className = "carousel-arrow carousel-next"; nextBtn.setAttribute("aria-label", "Siguiente"); nextBtn.innerHTML = svgDer;
  carousel.parentNode.insertBefore(wrap, carousel);
  wrap.appendChild(prevBtn); wrap.appendChild(nextBtn); wrap.appendChild(carousel);

  function stepPx() { return track.scrollWidth / totalSlides; }
  function update() { track.style.transform = "translateX(-" + stepPx() * index + "px)"; }
  update();

  function cancelBridgeReset() {
    if (bridgeResetHandler) { track.removeEventListener("transitionend", bridgeResetHandler); bridgeResetHandler = null; }
  }
  function saltoSinAnimacion(nuevoIndex) {
    track.style.transition = "none"; index = nuevoIndex; update(); void track.offsetWidth; track.style.transition = "";
  }
  function armBridgeReset() {
    cancelBridgeReset();
    bridgeResetHandler = function () { bridgeResetHandler = null; saltoSinAnimacion(0); };
    track.addEventListener("transitionend", bridgeResetHandler, { once: true });
  }

  // ----- Autoplay con pausas largas -----
  function startAutoplay() {
    stopAutoplay();
    autoplayTimer = setInterval(function () {
      index += 1; update();
      if (index >= realSlides) armBridgeReset();
    }, AUTOPLAY_MS);
  }
  function stopAutoplay() { if (autoplayTimer) clearInterval(autoplayTimer); autoplayTimer = null; }
  function pausar(msParaRetomar) {
    stopAutoplay();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function () {
      if (hovering || zoom) return; // sigue mirando: no se mueve
      startAutoplay();
    }, msParaRetomar);
  }
  startAutoplay();

  // Si hay movimiento sobre el carrusel (mouse encima o dedo), queda quieto
  // para dar tiempo a leer las 3 capturas a la vista.
  wrap.addEventListener("pointerenter", function (ev) { if (ev.pointerType === "mouse") { hovering = true; pausar(RESUME_AFTER_LEAVE_MS); } });
  wrap.addEventListener("pointermove", function (ev) { if (ev.pointerType === "mouse") { hovering = true; stopAutoplay(); } });
  wrap.addEventListener("pointerleave", function (ev) { if (ev.pointerType === "mouse") { hovering = false; pausar(RESUME_AFTER_LEAVE_MS); } });

  // ----- Navegación -----
  function irSiguiente() {
    cancelBridgeReset();
    if (index >= realSlides) saltoSinAnimacion(0);
    index += 1; update();
    if (index >= realSlides) armBridgeReset();
    pausar(RESUME_AFTER_TOUCH_MS);
  }
  function irAnterior() {
    cancelBridgeReset();
    if (index <= 0) saltoSinAnimacion(realSlides);
    index -= 1; update();
    pausar(RESUME_AFTER_TOUCH_MS);
  }
  nextBtn.addEventListener("click", irSiguiente);
  prevBtn.addEventListener("click", irAnterior);
  wrap.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowRight") { ev.preventDefault(); irSiguiente(); }
    if (ev.key === "ArrowLeft") { ev.preventDefault(); irAnterior(); }
  });
  var ruedaOcupada = false;
  wrap.addEventListener("wheel", function (ev) {
    var h = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : (ev.shiftKey ? ev.deltaY : 0);
    if (!h) return;
    ev.preventDefault();
    if (ruedaOcupada || Math.abs(h) < 8) return;
    ruedaOcupada = true;
    setTimeout(function () { ruedaOcupada = false; }, 550);
    if (h > 0) irSiguiente(); else irAnterior();
  }, { passive: false });

  // ----- Arrastre (mouse y dedo) -----
  var dragging = false, dragMoved = false, dragStartX = 0, dragStartOffsetPx = 0;
  function currentOffsetPx() {
    var m = new DOMMatrixReadOnly(getComputedStyle(track).transform);
    return -m.m41;
  }
  track.addEventListener("pointerdown", function (ev) {
    cancelBridgeReset();
    if (index >= realSlides) saltoSinAnimacion(0);
    dragging = true; dragMoved = false;
    dragStartX = ev.clientX;
    dragStartOffsetPx = currentOffsetPx();
    track.style.transition = "none";
    track.style.transform = "translateX(-" + dragStartOffsetPx + "px)";
    try { track.setPointerCapture(ev.pointerId); } catch (e) {}
    stopAutoplay();
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  });
  track.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    // En pantallas táctiles evita que el navegador tome el gesto como scroll de la página.
    if (ev.cancelable) ev.preventDefault();
    var dx = ev.clientX - dragStartX;
    if (Math.abs(dx) > 4) dragMoved = true;
    track.style.transform = "translateX(-" + (dragStartOffsetPx - dx) + "px)";
  });
  function endDrag(ev) {
    if (!dragging) return;
    dragging = false;
    track.style.transition = "";
    var dx = ev.clientX - dragStartX;
    var nuevo = Math.round((dragStartOffsetPx - dx) / stepPx());
    index = Math.max(0, Math.min(realSlides, nuevo));
    update();
    if (index >= realSlides) armBridgeReset();
    pausar(RESUME_AFTER_TOUCH_MS);
  }
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  track.addEventListener("pointerleave", function (ev) { if (dragging) endDrag(ev); });

  // ----- Zoom en el mismo lugar: tocar una captura la agranda un poco; tocarla
  // otra vez (o tocar afuera, o Esc) la devuelve a su tamaño. -----
  var ESCALA = 1.25;
  var zoom = null; // { el, slide }
  function lugarDe(slide) {
    var r = slide.getBoundingClientRect();
    return { left: r.left + window.pageXOffset, top: r.top + window.pageYOffset, width: r.width, height: r.height };
  }
  function lugarAmpliado(base) {
    var embebido = false;
    try { embebido = window.self !== window.top; } catch (e) { embebido = true; }
    var docW = document.documentElement.clientWidth;
    var s = Math.min(ESCALA, (docW - 16) / base.width);
    // Fuera de un iframe también se cuida que entre en la pantalla; dentro de uno
    // (ClickFunnels) la altura de la ventana es la de toda la página, no sirve.
    if (!embebido) s = Math.min(s, (window.innerHeight * 0.94) / base.height);
    s = Math.max(1, s);
    var w = base.width * s, h = base.height * s;
    var left = base.left - (w - base.width) / 2;
    var top = base.top - (h - base.height) / 2;
    left = Math.max(8, Math.min(left, docW - w - 8));
    if (!embebido) {
      // que se vea entera sin tener que mover la página
      var minTop = window.pageYOffset + 8, maxTop = window.pageYOffset + window.innerHeight - h - 8;
      top = Math.max(minTop, Math.min(top, Math.max(minTop, maxTop)));
    }
    return { left: left, top: top, width: w, height: h };
  }
  function ponerLugar(el, p) {
    el.style.left = p.left + "px"; el.style.top = p.top + "px";
    el.style.width = p.width + "px"; el.style.height = p.height + "px";
  }
  function abrirZoom(slide) {
    cerrarZoom(true);
    var img = slide.querySelector("img");
    if (!img) return;
    var base = lugarDe(slide);
    var el = document.createElement("div");
    el.className = "shu-zoom";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Captura ampliada. Toca para achicar");
    el.innerHTML = '<img alt="">';
    el.firstChild.src = img.getAttribute("src");
    el.firstChild.alt = img.getAttribute("alt") || "Captura de testimonio";
    ponerLugar(el, base);
    document.body.appendChild(el);
    void el.offsetWidth;
    el.classList.add("abierto");
    ponerLugar(el, lugarAmpliado(base));
    zoom = { el: el, slide: slide };
    stopAutoplay();
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    el.addEventListener("click", function (e) { e.stopPropagation(); cerrarZoom(); });
  }
  function cerrarZoom(sinAnimar) {
    if (!zoom) return;
    var z = zoom; zoom = null;
    if (sinAnimar) { z.el.remove(); return; }
    z.el.classList.remove("abierto");
    ponerLugar(z.el, lugarDe(z.slide));
    setTimeout(function () { z.el.remove(); }, 260);
    pausar(RESUME_AFTER_LEAVE_MS);
  }
  document.addEventListener("click", function (ev) { if (zoom && !zoom.el.contains(ev.target)) cerrarZoom(); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") cerrarZoom(); });
  window.addEventListener("resize", function () { cerrarZoom(true); });
  prevBtn.addEventListener("click", function () { cerrarZoom(true); }, true);
  nextBtn.addEventListener("click", function () { cerrarZoom(true); }, true);

  // Un toque (no un arrastre) agranda la captura. Se calcula por posición porque, con
  // el puntero capturado por el arrastre, el clic puede llegar al carril y no a la slide.
  track.addEventListener("click", function (ev) {
    if (dragMoved) { ev.preventDefault(); ev.stopPropagation(); return; }
    ev.stopPropagation();
    for (var i = 0; i < track.children.length; i++) {
      var r = track.children[i].getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right) { abrirZoom(track.children[i]); return; }
    }
  });
})();
