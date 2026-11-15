# CORPUS ULTIMATE — UI Smoothness, Animations & Haptics Plan

## Goal
Make the UI smoother with GPU-composited animations, add haptic feedback for mobile, and eliminate lag.

## Changes

### 1. New file: `frontend/css/animations.css`
- Keyframe animations: fade-in, slide-up, slide-down, scale-in, shimmer, pulse, ripple
- Utility classes: `.animate-fade-in`, `.animate-slide-up`, `.stagger-children > *`, `.ripple`, `.will-change-transform`, `.will-change-opacity`
- Reduced motion support (`prefers-reduced-motion`)

### 2. `frontend/index.html`
- Link `css/animations.css` after other stylesheets

### 3. `frontend/css/layout.css`
- Add `will-change: transform` to sidebar, modals, toasts
- Add `content-visibility: auto` to off-screen containers
- Add `passive: true` to scroll/touch listeners where applicable
- Smooth scroll behavior already present; reinforce with `scroll-behavior: smooth`

### 4. `frontend/css/components.css`
- Add ripple effect on button clicks (`::after` pseudo-element with expanding circle)
- Add hover scale/translate animations on cards, list items, nav items
- Add stagger animation classes for list rendering
- Optimize transitions to use only `transform` and `opacity`

### 5. `frontend/js/components.js`
- Add `haptic()` function using `navigator.vibrate()` with fallback
- Wire haptics into: button clicks, toast dismiss, toggle switches, nav links, modal open/close, form submissions
- Add `prefers-reduced-motion` respect

### 6. `frontend/js/router.js`
- Add page container fade-out on navigate, fade-in on new page render
- Add `AOS.refresh()` already present; keep it

### Testing
- `check_preview` on all major routes to confirm no JS errors and smooth rendering