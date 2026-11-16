package com.example.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColorScheme = darkColorScheme(
    primary = AriaPrimary,
    onPrimary = Color.White,
    primaryContainer = AriaDarkSurfaceElevated,
    onPrimaryContainer = AriaAccent,
    secondary = AriaSecondary,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF381525),
    onSecondaryContainer = AriaAccent,
    tertiary = AriaAccent,
    onTertiary = Color.Black,
    background = AriaDarkBackground,
    onBackground = AriaText,
    surface = AriaDarkSurface,
    onSurface = AriaText,
    surfaceVariant = AriaDarkSurfaceElevated,
    onSurfaceVariant = AriaMutedText,
    outline = AriaBorder,
    outlineVariant = AriaBorderStrong,
    error = AriaError,
    onError = Color.White
)

private val LightColorScheme = lightColorScheme(
    primary = AriaPrimary,
    onPrimary = Color.White,
    primaryContainer = AriaLightSurfaceElevated,
    onPrimaryContainer = AriaSecondary,
    secondary = AriaSecondary,
    onSecondary = Color.White,
    tertiary = AriaAccent,
    background = AriaLightBackground,
    onBackground = AriaLightText,
    surface = AriaLightSurface,
    onSurface = AriaLightText,
    surfaceVariant = AriaLightSurfaceElevated,
    onSurfaceVariant = AriaLightMutedText,
    outline = Color(0x33FF4D8D),
    error = AriaError,
    onError = Color.White
)

@Composable
fun AriaTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
        typography = Typography,
        content = content
    )
}
