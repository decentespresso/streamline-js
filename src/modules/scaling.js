let isInitialScaleDone = false; // module-level: only first initScaling call adds .scaled

export function initScaling() {
    const viewport = document.getElementById('scaling-container');
    const content = document.getElementById('scaled-content');
    const designWidth = 1920;
    const designHeight = 1200;
    let baselineHeight = window.innerHeight;

    // Detect if device is mobile
    function isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    // Check if in portrait orientation
    function isPortrait() {
        return window.innerHeight > window.innerWidth;
    }

    // Show/hide rotation prompt for mobile portrait mode
    function updateRotationPrompt() {
        const isMobile = isMobileDevice();
        const portrait = isPortrait();
        const toastContainer = document.getElementById('fullscreen-toast-container');

        if (!toastContainer) return;

        // Show prompt only on mobile devices in portrait mode
        // Don't show if user has dismissed it in this session
        const shouldShow = isMobile && portrait && !sessionStorage.getItem('rotationPromptDismissed');

        if (shouldShow && toastContainer.style.display !== 'grid') {
            // Update the toast content for rotation prompt
            const alertBox = toastContainer.querySelector('.alert');
            const heading = alertBox?.querySelector('h3');
            // Use a more reliable selector for the message div
            const messageDiv = alertBox?.querySelector('div[class*="text-"][style*="font-size"]') ||
                              alertBox?.querySelectorAll('div')[1]?.querySelector('div') ||
                              alertBox?.querySelector('.text-\\[9px\\]');
            const buttonContainer = alertBox?.querySelector('.flex.gap-2');

            if (heading) heading.textContent = 'Rotate Your Device';
            if (messageDiv) messageDiv.textContent = 'For the best experience, please rotate to landscape mode.';

            // Update buttons - Rotate button + Remind Later button
            if (buttonContainer) {
                buttonContainer.innerHTML = `
                    <button id="toast-rotate-btn" class="btn btn-primary btn-sm text-white" data-i18n-key="Rotate">Rotate</button>
                    <button id="toast-rotate-remind-btn" class="btn btn-ghost btn-sm" data-i18n-key="Remind Later">Remind Later</button>
                `;

                // Add click handlers
                setTimeout(() => {
                    // Rotate button handler
                    const rotateBtn = document.getElementById('toast-rotate-btn');
                    if (rotateBtn) {
                        rotateBtn.onclick = async () => {
                            try {
                                // Try to use Screen Orientation API
                                if (screen.orientation && screen.orientation.lock) {
                                    await screen.orientation.lock('landscape');
                                    toastContainer.style.display = 'none';
                                } else {
                                    // Fallback: Show instructions if API not supported
                                    alert('Auto-rotation not supported on this device. Please physically rotate your device to landscape mode.');
                                }
                            } catch (error) {
                                // If rotation fails, show helpful message
                                console.warn('Screen rotation failed:', error);
                                alert('Please physically rotate your device to landscape mode.');
                            }
                        };
                    }

                    // Remind Later button handler
                    const remindBtn = document.getElementById('toast-rotate-remind-btn');
                    if (remindBtn) {
                        remindBtn.onclick = () => {
                            toastContainer.style.display = 'none';
                            sessionStorage.setItem('rotationPromptDismissed', 'true');
                        };
                    }
                }, 0);
            }

            toastContainer.style.display = 'grid';
        } else if (!shouldShow && toastContainer.style.display === 'grid') {
            // Hide if conditions no longer met (user rotated or dismissed)
            toastContainer.style.display = 'none';
        }
    }

    function updateScale() {
        if (!viewport || !content) return;

        // Get actual viewport dimensions — guard against keyboard shrinking innerHeight
        const screenWidth = window.innerWidth;
        const rawHeight = window.innerHeight;
        const activeEl = document.activeElement;
        const inputFocused = activeEl &&
            (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
        const keyboardShrunk = inputFocused && rawHeight < baselineHeight * 0.85;
        const screenHeight = keyboardShrunk ? baselineHeight : rawHeight;
        if (!keyboardShrunk) baselineHeight = rawHeight;

        // Width always fills. What happens vertically depends on the screen's aspect
        // relative to the 16:10 design canvas:
        //
        //   taller than 16:10 (4:3 iPads)  -> keep the scale uniform and GROW the
        //     canvas past 1200 design rows. #main-page is a flex column whose <main>
        //     grows, so the extra rows land in the chart instead of in black bars.
        //     No stretch, no letterbox.
        //   shorter than 16:10 (A7 1340x800, 16:9 panels) -> can't grow into rows that
        //     aren't there, so fall back to the TCL-style independent x/y squash
        //     (dui.tcl uses separate xscale_factor/yscale_factor for the same reason),
        //     clamped so round controls don't visibly turn into ellipses.
        let sx = screenWidth / designWidth;
        let sy = screenHeight / designHeight;
        let canvasHeight = designHeight;

        if (screenHeight / sx >= designHeight) {
            sy = sx;
            canvasHeight = screenHeight / sx;
        } else {
            // Only screens shorter than 16:10 land here, so this clamp no longer has
            // to protect the 4:3 iPads (they take the grow branch above) -- it can
            // stay loose enough to cover an A7 Lite whose height is eaten by browser
            // chrome (1340x736 needs 1.138). localStorage 'maxStretch': 1.0 = never
            // squash (letterbox instead), higher = fill more aggressively.
            const MAX_STRETCH = parseFloat(localStorage.getItem('maxStretch') || '1.15');
            const stretch = Math.max(sx, sy) / Math.min(sx, sy);
            if (stretch > MAX_STRETCH) {
                const k = MAX_STRETCH / stretch;
                if (sx > sy) sx *= k; else sy *= k;
            }
        }

        content.style.width = `${designWidth}px`;
        content.style.height = `${canvasHeight}px`;

        // Option A: only apply user zoom when the base scale < 1.0
        // (i.e. UI is already smaller than designed — small/tablet screens).
        // Large screens already have readable text; zooming them would clip with no benefit.
        const uiZoom = parseFloat(localStorage.getItem('uiZoom') || '1.0');
        sx *= uiZoom;
        sy *= uiZoom;

        // Cap at 2.0x to prevent excessive scale on very high-DPI displays
        const maxScale = 2.0;
        if (sx > maxScale) sx = maxScale;
        if (sy > maxScale) sy = maxScale;

        let offsetX, offsetY;
        if (uiZoom > 1.0) {
            // Option D: anchor an edge when zoomed — overflow the opposite side instead of
            // clipping all around. Normally left-anchored so the left sidebar (primary
            // controls) always stays fully visible. GHC machines put a second control
            // column (coffee/water/steam/flush/stop) flush against the design canvas's
            // right edge (x:1748-1920) — left-anchoring would push that off-screen first,
            // so right-anchor instead while it's shown, sacrificing chart/history overflow
            // on the left rather than the machine controls on the right.
            const ghcVisible = document.getElementById('ghc-controls')?.style.display === 'flex';
            offsetX = ghcVisible ? screenWidth - designWidth * sx : 0;
            offsetY = 0;
            // Option C: allow scroll so no content is permanently inaccessible when zoomed.
            // On tablets this enables touch-scroll/pan to reach the chart and data panels.
            viewport.style.overflow = 'auto';
        } else {
            // Default: center whatever residual gap the stretch clamp left behind
            // (zero on the grow path -- the canvas fits the screen exactly there)
            offsetX = (screenWidth - designWidth * sx) / 2;
            offsetY = (screenHeight - canvasHeight * sy) / 2;
            viewport.style.overflow = 'hidden';
        }

        content.style.transformOrigin = 'top left';
        content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${sx}, ${sy})`;

        viewport.style.width = `${screenWidth}px`;
        viewport.style.height = `${screenHeight}px`;
        viewport.style.margin = '0';

        // `scale` kept for existing listeners; it is the horizontal factor, which is
        // what pointer-coordinate math against offsetWidth needs.
        document.dispatchEvent(new CustomEvent('streamline:scaleupdate', {
            detail: { scale: sx, scaleX: sx, scaleY: sy }
        }));
    }

    updateScale();
    if (content && !isInitialScaleDone) {
        isInitialScaleDone = true;
        requestAnimationFrame(() => content.classList.add('scaled'));
    }
    setTimeout(updateScale, 250);
    
    // Add resize listener with debounce to prevent excessive recalculations
    let resizeTimer;
    const onResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            updateScale();
            updateRotationPrompt();
            setTimeout(updateScale, 200);
        }, 150);
    };
    window.addEventListener('resize', onResize);

    // visualViewport fires reliably on iOS/Android when the soft keyboard appears/hides,
    // which doesn't always trigger window.resize in tablet WebViews.
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
    }
    
    // Also listen for orientation changes which can affect viewport dimensions
    window.addEventListener('orientationchange', () => {
        console.log('Orientation change event detected');
        // Multiple updates with increasing delays to handle Firefox and other browsers
        // that may take time to report correct viewport dimensions
        setTimeout(() => {
            console.log('First scale update after orientation change');
            updateScale();
            updateRotationPrompt();
        }, 200);
        
        setTimeout(() => {
            console.log('Second scale update after orientation change');
            updateScale();
        }, 500);
        
        setTimeout(() => {
            console.log('Final scale update after orientation change');
            updateScale();
        }, 800);
    });
    
    // Listen for fullscreen change events which might affect scaling
    document.addEventListener('fullscreenchange', () => {
        setTimeout(() => {
            updateScale();
            updateRotationPrompt(); // Check if rotation prompt should be shown/hidden
        }, 100); // Allow time for fullscreen transition to complete
    });
    
    // Listen for webkit-specific fullscreen change events (Safari)
    document.addEventListener('webkitfullscreenchange', () => {
        setTimeout(() => {
            updateScale();
            updateRotationPrompt(); // Check if rotation prompt should be shown/hidden
        }, 100); // Allow time for fullscreen transition to complete
    });
    
    // Initial rotation prompt check (after a delay to ensure DOM is ready)
    setTimeout(updateRotationPrompt, 500);
}
