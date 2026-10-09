/* Carrusel de capturas de testimonios (compartido por index, webinar y testimonios).
   Autoplay infinito con zona de clones, arrastre (mouse y dedo), flechas, teclado,
   trackpad horizontal y visor al tocar una captura. Necesita #carouselTrack con las
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
  var hovering = false, lightboxAbierto = false;

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
      if (hovering || lightboxAbierto) return; // sigue mirando: no se mueve
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

  // ----- Visor: tocar una captura la abre grande -----
  var imgs = [];
  for (var i = 0; i < realSlides; i++) {
    var im = track.children[i].querySelector("img");
    imgs.push({ src: im ? im.getAttribute("src") : "", alt: im ? im.getAttribute("alt") : "" });
  }
  var lb = document.createElement("div");
  lb.className = "shu-lb";
  lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "Captura ampliada");
  lb.innerHTML =
    '<div class="shu-lb-stage">' +
    '<div class="shu-lb-cuenta"></div>' +
    '<button type="button" class="shu-lb-btn shu-lb-cerrar" aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
    '<button type="button" class="shu-lb-btn shu-lb-prev" aria-label="Anterior">' + svgIzq + '</button>' +
    '<button type="button" class="shu-lb-btn shu-lb-next" aria-label="Siguiente">' + svgDer + '</button>' +
    '<img alt="">' +
    '</div>';
  document.body.appendChild(lb);
  var lbImg = lb.querySelector("img"), lbCuenta = lb.querySelector(".shu-lb-cuenta");
  var lbActual = 0;
  var embebido = false;
  try { embebido = window.self !== window.top; } catch (e) { embebido = true; }

  function pintarLb() {
    lbImg.src = imgs[lbActual].src;
    lbImg.alt = imgs[lbActual].alt || "Captura de testimonio";
    lbCuenta.textContent = (lbActual + 1) + " / " + imgs.length;
  }
  function abrirLb(i) {
    lbActual = ((i % imgs.length) + imgs.length) % imgs.length;
    pintarLb();
    lightboxAbierto = true;
    stopAutoplay();
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (embebido) {
      // Dentro de un iframe (ClickFunnels) el visor no puede ocupar "la pantalla":
      // el iframe mide toda la página. Se ancla donde está el carrusel, que es donde
      // la persona acaba de tocar y por eso está a la vista.
      var r = wrap.getBoundingClientRect();
      var alto = Math.min(820, Math.max(520, window.innerHeight - 40));
      var centro = r.top + window.pageYOffset + r.height / 2;
      lb.classList.add("incrustado");
      lb.style.top = Math.max(0, centro - alto / 2) + "px";
      lb.style.height = alto + "px";
    } else {
      document.body.style.overflow = "hidden";
    }
    lb.classList.add("open");
    lb.querySelector(".shu-lb-cerrar").focus();
  }
  function cerrarLb() {
    lb.classList.remove("open");
    lightboxAbierto = false;
    if (!embebido) document.body.style.overflow = "";
    pausar(RESUME_AFTER_LEAVE_MS);
  }
  lb.querySelector(".shu-lb-cerrar").addEventListener("click", cerrarLb);
  lb.querySelector(".shu-lb-prev").addEventListener("click", function (e) { e.stopPropagation(); lbActual = (lbActual - 1 + imgs.length) % imgs.length; pintarLb(); });
  lb.querySelector(".shu-lb-next").addEventListener("click", function (e) { e.stopPropagation(); lbActual = (lbActual + 1) % imgs.length; pintarLb(); });
  lb.addEventListener("click", function (e) { if (e.target === lb || e.target.classList.contains("shu-lb-stage")) cerrarLb(); });
  document.addEventListener("keydown", function (ev) {
    if (!lightboxAbierto) return;
    if (ev.key === "Escape") cerrarLb();
    if (ev.key === "ArrowRight") { lbActual = (lbActual + 1) % imgs.length; pintarLb(); }
    if (ev.key === "ArrowLeft") { lbActual = (lbActual - 1 + imgs.length) % imgs.length; pintarLb(); }
  });
  var tx = null;
  lb.addEventListener("touchstart", function (e) { tx = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", function (e) {
    if (tx == null) return;
    var dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) < 50) return;
    lbActual = (lbActual + (dx < 0 ? 1 : imgs.length - 1)) % imgs.length; pintarLb();
  }, { passive: true });

  // Un toque (no un arrastre) abre la captura. Se calcula por posición porque, con el
  // puntero capturado por el arrastre, el clic puede llegar al carril y no a la slide.
  track.addEventListener("click", function (ev) {
    if (dragMoved) { ev.preventDefault(); ev.stopPropagation(); return; }
    for (var i = 0; i < track.children.length; i++) {
      var r = track.children[i].getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right) { abrirLb(i % realSlides); return; }
    }
  });
})();
