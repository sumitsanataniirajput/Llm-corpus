package com.example.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

// --- Aria Deep Void & Vivid Violet/Fuchsia Design System Palette ---
// Matching the reference image: deep void backdrop (#05020A to #0D0618)
// with luminous fuchsia/purple glows (#9D4EDD, #B5179E, #FF2E93, #7209B7)
val AriaDarkBackground = Color(0xFF07040D) // Deep obsidian with soft purple/plum undertone
val AriaDarkSurface = Color(0xFF130A1F) // Translucent deep violet surface
val AriaDarkSurfaceElevated = Color(0xFF1C102E) // Elevated card surface with glass sheen
val AriaDarkSurfaceCard = Color(0xFF170C26) // Intermediate card surface

// Luminous primary accents from reference UI
val AriaPrimary = Color(0xFFB5179E) // Vivid magenta / fuchsia
val AriaSecondary = Color(0xFF7209B7) // Deep electric purple
val AriaAccent = Color(0xFF4CC9F0) // Cyan/electric blue sparkle
val AriaNeonViolet = Color(0xFF9D4EDD) // Bright neon purple
val AriaHotPink = Color(0xFFFF2E93) // Hot fuchsia pink accent

val AriaText = Color(0xFFF7F2FA) // Ultra crisp soft white with slight lavender tint
val AriaMutedText = Color(0xFF9E8DB3) // Refined muted lavender-gray
val AriaSubtleText = Color(0xFF6B5A82) // Subtle secondary caption text

val AriaSuccess = Color(0xFF4ADE80) // Fresh mint green
val AriaError = Color(0xFFFF5C5C) // Vivid alert coral red
val AriaBorder = Color(0x339D4EDD) // Delicate 20% neon violet glass border
val AriaBorderStrong = Color(0x66B5179E) // 40% fuchsia glow border

// Light theme counterparts
val AriaLightBackground = Color(0xFFF9F6FC)
val AriaLightSurface = Color(0xFFFFFFFF)
val AriaLightSurfaceElevated = Color(0xFFF1E9F8)
val AriaLightText = Color(0xFF1E0E30)
val AriaLightMutedText = Color(0xFF6D5C80)

// Gradients matching reference image hero & buttons
val AriaPinkRedGradient = Brush.horizontalGradient(
    colors = listOf(Color(0xFFB5179E), Color(0xFF7209B7))
)

val AriaHeroGradient = Brush.horizontalGradient(
    colors = listOf(Color(0xFFFF2E93), Color(0xFF9D4EDD), Color(0xFF4CC9F0))
)

val AriaVerticalPinkRedGradient = Brush.verticalGradient(
    colors = listOf(Color(0xFFB5179E), Color(0xFF7209B7))
)

val AriaCosmicAuraGradient = Brush.radialGradient(
    colors = listOf(
        Color(0x779D4EDD),
        Color(0x337209B7),
        Color(0x0007040D)
    )
)

val AriaAvatarGlowGradient = Brush.radialGradient(
    colors = listOf(
        Color(0x77B5179E),
        Color(0x447209B7),
        Color(0x0007040D)
    )
)
