package com.example.ui

import android.net.Uri
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Nightlight
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.example.R
import com.example.model.AriaEmotion
import com.example.model.AvatarState
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaHotPink
import com.example.ui.theme.AriaNeonViolet
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary

/**
 * Wholesome 2D black & pink mascot character with realistic layered facial expressions,
 * realistic closed eyes when sleeping, dynamic mouth lip-sync, subtle head sway,
 * breathing motion, and optional custom user-uploaded avatar support.
 */
@Composable
fun AriaAvatarComponent(
    state: AvatarState,
    modifier: Modifier = Modifier,
    emotion: AriaEmotion = AriaEmotion.HAPPY,
    size: Dp = 100.dp,
    audioAmplitude: Float = 0f,
    isReadingScreen: Boolean = false,
    isAwarenessActive: Boolean = true,
    customAvatarUri: String? = null
) {
    val context = LocalContext.current
    val infiniteTransition = rememberInfiniteTransition(label = "avatar_anim")

    // Idle breathing animation
    val breathingScale by infiniteTransition.animateFloat(
        initialValue = 0.98f,
        targetValue = 1.02f,
        animationSpec = infiniteRepeatable(
            animation = tween(2400, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "breathing"
    )

    // Subtle head sway
    val headSway by infiniteTransition.animateFloat(
        initialValue = -1.2f,
        targetValue = 1.2f,
        animationSpec = infiniteRepeatable(
            animation = tween(3200, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "sway"
    )

    // Speaking / Listening pulse
    val auraPulse by infiniteTransition.animateFloat(
        initialValue = 0.97f,
        targetValue = 1.05f,
        animationSpec = infiniteRepeatable(
            animation = tween(1100, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "aura_pulse"
    )

    // Orbiting dots during Thinking state
    val thinkingOrbit by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(2000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "thinking_orbit"
    )

    // Sleeping floating Zzz
    val zzzFloat by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = -10f,
        animationSpec = infiniteRepeatable(
            animation = tween(1500, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "zzz_float"
    )

    // Sleeping peaceful breath cycle
    val sleepBreath by infiniteTransition.animateFloat(
        initialValue = 0.96f,
        targetValue = 1.01f,
        animationSpec = infiniteRepeatable(
            animation = tween(3000, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "sleep_breath"
    )

    // Screen awareness dot pulse
    val awarenessDotPulse by infiniteTransition.animateFloat(
        initialValue = 0.4f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(600, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "awareness_dot"
    )

    // Smooth 300ms emotion color blend
    val animatedEmotionColor by animateColorAsState(
        targetValue = Color(emotion.colorHex),
        animationSpec = tween(300),
        label = "emotion_color"
    )

    // State base aura colors
    val (stateAuraStart, stateAuraEnd, badgeIcon) = when (state) {
        AvatarState.SLEEPING -> Triple(Color(0xFF2B1438), Color(0xFF130A1F), Icons.Outlined.Nightlight)
        AvatarState.LISTENING -> Triple(AriaNeonViolet, AriaAccent, Icons.Outlined.Mic)
        AvatarState.THINKING -> Triple(Color(0xFFFF9E00), AriaPrimary, Icons.Outlined.Psychology)
        AvatarState.SPEAKING -> Triple(AriaPrimary, AriaSecondary, Icons.Outlined.GraphicEq)
        AvatarState.WORKING -> Triple(Color(0xFF4ADE80), AriaNeonViolet, Icons.Outlined.Build)
    }

    val avatarAlpha = if (state == AvatarState.SLEEPING) 0.72f else 1.0f
    val currentScale = if (state == AvatarState.SLEEPING) sleepBreath else breathingScale

    Box(
        modifier = modifier
            .size(size)
            .scale(currentScale)
            .rotate(if (emotion == AriaEmotion.CURIOUS) 4f else headSway),
        contentAlignment = Alignment.Center
    ) {
        // Outer soft radiant glowing halo ring
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .scale(if (state == AvatarState.SPEAKING || state == AvatarState.LISTENING) auraPulse else 1.0f)
                .rotate(if (state == AvatarState.THINKING) thinkingOrbit else 0f)
        ) {
            val radius = this.size.minDimension / 2f
            val centerOffset = Offset(this.size.width / 2f, this.size.height / 2f)

            // Radial cosmic background glow
            if (state != AvatarState.SLEEPING) {
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            animatedEmotionColor.copy(alpha = 0.45f),
                            AriaSecondary.copy(alpha = 0.25f),
                            Color.Transparent
                        ),
                        center = centerOffset,
                        radius = radius
                    ),
                    radius = radius,
                    center = centerOffset
                )
            }

            // Outer decorative gradient border ring
            drawCircle(
                brush = Brush.sweepGradient(
                    colors = listOf(
                        stateAuraStart,
                        animatedEmotionColor,
                        stateAuraEnd,
                        stateAuraStart
                    )
                ),
                radius = radius - 4.dp.toPx(),
                center = centerOffset,
                style = Stroke(
                    width = if (state == AvatarState.WORKING || state == AvatarState.LISTENING) 3.5.dp.toPx() else 2.5.dp.toPx()
                )
            )
        }

        // Mascot Portrait Card Container
        Box(
            modifier = Modifier
                .size(size - 12.dp)
                .clip(CircleShape)
                .background(Color(0xFF0F0818))
                .border(
                    width = 2.dp,
                    brush = Brush.linearGradient(
                        colors = listOf(animatedEmotionColor.copy(alpha = 0.9f), AriaSecondary.copy(alpha = 0.7f))
                    ),
                    shape = CircleShape
                )
                .shadow(elevation = 8.dp, shape = CircleShape)
                .alpha(avatarAlpha),
            contentAlignment = Alignment.Center
        ) {
            // High-res wholesome black & pink mascot image or custom uploaded avatar
            if (!customAvatarUri.isNullOrBlank()) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(Uri.parse(customAvatarUri))
                        .crossfade(true)
                        .build(),
                    contentDescription = "Custom User Avatar",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Image(
                    painter = painterResource(id = R.drawable.aria_pink_mascot),
                    contentDescription = "Aria Black & Pink Mascot",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            }

            // Real dynamic facial expressions overlaid on character
            Canvas(modifier = Modifier.fillMaxSize()) {
                val w = this.size.width
                val h = this.size.height

                // 1. SLEEPING STATE: Closed, curved smiling resting eyelashes (NOT open eyes)
                if (state == AvatarState.SLEEPING || emotion == AriaEmotion.SLEEPY) {
                    // Soft skin-tone shade over the eye sockets to completely shut the open eyes
                    val eyeShade = Color(0xFFF0D7D0) // Matches anime character skin tone
                    drawOval(
                        color = eyeShade,
                        topLeft = Offset(w * 0.28f, h * 0.40f),
                        size = Size(w * 0.18f, h * 0.15f)
                    )
                    drawOval(
                        color = eyeShade,
                        topLeft = Offset(w * 0.54f, h * 0.40f),
                        size = Size(w * 0.18f, h * 0.15f)
                    )

                    // Peaceful curved shut eye lashes (U-shaped downward curve ^_^)
                    val lashColor = Color(0xFF281822)
                    val strokeW = 2.4.dp.toPx()

                    // Left closed eye arch
                    val leftEyePath = Path().apply {
                        moveTo(w * 0.29f, h * 0.46f)
                        quadraticTo(w * 0.37f, h * 0.51f, w * 0.45f, h * 0.46f)
                    }
                    drawPath(leftEyePath, color = lashColor, style = Stroke(width = strokeW, cap = StrokeCap.Round))

                    // Right closed eye arch
                    val rightEyePath = Path().apply {
                        moveTo(w * 0.55f, h * 0.46f)
                        quadraticTo(w * 0.63f, h * 0.51f, w * 0.71f, h * 0.46f)
                    }
                    drawPath(rightEyePath, color = lashColor, style = Stroke(width = strokeW, cap = StrokeCap.Round))

                    // Soft peaceful sleeping blush
                    val sleepBlush = AriaHotPink.copy(alpha = 0.35f)
                    drawOval(color = sleepBlush, topLeft = Offset(w * 0.24f, h * 0.54f), size = Size(w * 0.16f, h * 0.08f))
                    drawOval(color = sleepBlush, topLeft = Offset(w * 0.60f, h * 0.54f), size = Size(w * 0.16f, h * 0.08f))
                } else {
                    // 2. ACTIVE EMOTION FACIAL EXPRESSIONS
                    when (emotion) {
                        AriaEmotion.HAPPY -> {
                            // Cheerful rosy blush
                            val blushColor = AriaHotPink.copy(alpha = 0.45f)
                            drawOval(color = blushColor, topLeft = Offset(w * 0.22f, h * 0.56f), size = Size(w * 0.16f, h * 0.08f))
                            drawOval(color = blushColor, topLeft = Offset(w * 0.62f, h * 0.56f), size = Size(w * 0.16f, h * 0.08f))
                        }

                        AriaEmotion.SHY -> {
                            // Deep bashful blush across cheeks and nose bridge
                            val blushColor = AriaHotPink.copy(alpha = 0.60f)
                            drawOval(color = blushColor, topLeft = Offset(w * 0.20f, h * 0.55f), size = Size(w * 0.20f, h * 0.10f))
                            drawOval(color = blushColor, topLeft = Offset(w * 0.60f, h * 0.55f), size = Size(w * 0.20f, h * 0.10f))
                            // Three cute diagonal blush lines ///
                            val blushLineColor = AriaSecondary.copy(alpha = 0.75f)
                            for (i in 0..2) {
                                drawLine(blushLineColor, Offset(w * (0.24f + i * 0.03f), h * 0.56f), Offset(w * (0.22f + i * 0.03f), h * 0.62f), 1.5.dp.toPx())
                                drawLine(blushLineColor, Offset(w * (0.64f + i * 0.03f), h * 0.56f), Offset(w * (0.62f + i * 0.03f), h * 0.62f), 1.5.dp.toPx())
                            }
                        }

                        AriaEmotion.EXCITED, AriaEmotion.PROUD -> {
                            // Big sparkling stars in eyes and cheeks
                            val starColor = Color(0xFFFFD166)
                            drawCircle(color = starColor, radius = 3.5.dp.toPx(), center = Offset(w * 0.24f, h * 0.54f))
                            drawCircle(color = starColor, radius = 3.5.dp.toPx(), center = Offset(w * 0.76f, h * 0.54f))
                            drawCircle(color = Color.White, radius = 2.dp.toPx(), center = Offset(w * 0.36f, h * 0.43f))
                            drawCircle(color = Color.White, radius = 2.dp.toPx(), center = Offset(w * 0.64f, h * 0.43f))
                        }

                        AriaEmotion.ANGRY, AriaEmotion.ANNOYED -> {
                            // Furrowed sharp eyebrows and flushed cheeks
                            val browColor = AriaSecondary
                            drawLine(
                                color = browColor,
                                start = Offset(w * 0.28f, h * 0.37f),
                                end = Offset(w * 0.44f, h * 0.41f),
                                strokeWidth = 3.dp.toPx(),
                                cap = StrokeCap.Round
                            )
                            drawLine(
                                color = browColor,
                                start = Offset(w * 0.72f, h * 0.37f),
                                end = Offset(w * 0.56f, h * 0.41f),
                                strokeWidth = 3.dp.toPx(),
                                cap = StrokeCap.Round
                            )
                            // Cute manga anger mark symbol 💢 on temple
                            val angerColor = AriaHotPink
                            val ax = w * 0.78f
                            val ay = h * 0.30f
                            val asize = 7.dp.toPx()
                            drawLine(angerColor, Offset(ax - asize, ay), Offset(ax + asize, ay), 2.dp.toPx(), StrokeCap.Round)
                            drawLine(angerColor, Offset(ax, ay - asize), Offset(ax, ay + asize), 2.dp.toPx(), StrokeCap.Round)
                        }

                        AriaEmotion.SURPRISED -> {
                            // Wide dilated pupil sparkles and raised eyebrows
                            drawCircle(color = Color.White, radius = 4.dp.toPx(), center = Offset(w * 0.37f, h * 0.44f))
                            drawCircle(color = Color.White, radius = 4.dp.toPx(), center = Offset(w * 0.63f, h * 0.44f))
                            // Arched high eyebrows
                            val browColor = Color(0xFF281822)
                            val leftSurprisePath = Path().apply {
                                moveTo(w * 0.30f, h * 0.38f)
                                quadraticTo(w * 0.37f, h * 0.34f, w * 0.44f, h * 0.38f)
                            }
                            drawPath(leftSurprisePath, color = browColor, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
                            val rightSurprisePath = Path().apply {
                                moveTo(w * 0.56f, h * 0.38f)
                                quadraticTo(w * 0.63f, h * 0.34f, w * 0.70f, h * 0.38f)
                            }
                            drawPath(rightSurprisePath, color = browColor, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
                        }

                        AriaEmotion.SAD, AriaEmotion.SCARED -> {
                            // Tear drops on cheek
                            val tearColor = Color(0xFF4CC9F0)
                            drawCircle(color = tearColor, radius = 3.5.dp.toPx(), center = Offset(w * 0.68f, h * 0.60f))
                            drawCircle(color = tearColor.copy(alpha = 0.6f), radius = 2.5.dp.toPx(), center = Offset(w * 0.68f, h * 0.68f))
                            // Troubled droopy brows
                            val browColor = Color(0xFF281822)
                            drawLine(browColor, Offset(w * 0.30f, h * 0.39f), Offset(w * 0.43f, h * 0.35f), 2.dp.toPx(), StrokeCap.Round)
                            drawLine(browColor, Offset(w * 0.70f, h * 0.39f), Offset(w * 0.57f, h * 0.35f), 2.dp.toPx(), StrokeCap.Round)
                        }

                        AriaEmotion.CURIOUS -> {
                            // One raised eyebrow and small question mark twinkle
                            val browColor = Color(0xFF281822)
                            drawLine(browColor, Offset(w * 0.56f, h * 0.34f), Offset(w * 0.70f, h * 0.38f), 2.2.dp.toPx(), StrokeCap.Round)
                        }

                        else -> {}
                    }
                }
            }

            // Lip-sync: dynamic mouth opening driven by audio amplitude (only while awake)
            if (state != AvatarState.SLEEPING && (state == AvatarState.SPEAKING || audioAmplitude > 0.04f)) {
                val mouthHeight = (3 + (audioAmplitude.coerceIn(0f, 1f) * 11f)).dp
                val mouthWidth = (8 + (audioAmplitude.coerceIn(0f, 1f) * 7f)).dp

                Box(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .offset(y = 19.dp)
                        .size(width = mouthWidth, height = mouthHeight)
                        .background(
                            color = AriaHotPink,
                            shape = RoundedCornerShape(percent = 50)
                        )
                        .border(
                            width = 1.dp,
                            color = AriaSecondary,
                            shape = RoundedCornerShape(percent = 50)
                        )
                )
            }

            // Floating Zzz indicator when sleeping
            if (state == AvatarState.SLEEPING || emotion == AriaEmotion.SLEEPY) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = (-12).dp, y = (10 + zzzFloat).dp)
                ) {
                    Text(
                        text = "Zzz",
                        color = AriaAccent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        // Live Screen Awareness Sensor Dot (Top Start)
        if (isAwarenessActive) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .offset(x = 4.dp, y = 4.dp)
                    .size(14.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF07040D))
                    .border(1.5.dp, if (isReadingScreen) AriaHotPink else AriaNeonViolet, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(if (isReadingScreen) 8.dp else 6.dp)
                        .clip(CircleShape)
                        .background(
                            if (isReadingScreen) AriaHotPink.copy(alpha = awarenessDotPulse)
                            else AriaAccent.copy(alpha = 0.85f)
                        )
                )
            }
        }

        // Status badge chip (Bottom End)
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .offset(x = (-2).dp, y = (-2).dp)
                .size(24.dp)
                .clip(CircleShape)
                .background(Color(0xFF130A1F))
                .border(1.5.dp, AriaNeonViolet, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = badgeIcon,
                contentDescription = state.name,
                tint = AriaNeonViolet,
                modifier = Modifier.size(13.dp)
            )
        }
    }
}
