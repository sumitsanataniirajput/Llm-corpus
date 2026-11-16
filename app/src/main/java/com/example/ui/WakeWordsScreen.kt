package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Nightlight
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText

@Composable
fun WakeWordsScreen(
    prefs: AriaPreferences,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    var wakePhrase by remember { mutableStateOf(prefs.wakePhrase) }
    var sleepPhrase by remember { mutableStateOf(prefs.sleepPhrase) }
    var silenceTimeout by remember { mutableIntStateOf(prefs.silenceTimeoutSeconds) }
    var startOnBoot by remember { mutableStateOf(prefs.startOnBoot) }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = AriaText
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Column {
                    Text(
                        text = "Wake & Sleep Phrases",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = AriaText
                    )
                    Text(
                        text = "Instant fuzzy phonetic matching with zero retraining",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )
                }
            }
        }

        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Custom Trigger Phrases",
                        fontWeight = FontWeight.Bold,
                        color = AriaText,
                        fontSize = 15.sp
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Matches phonetically so typos or accents are automatically understood.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    OutlinedTextField(
                        value = wakePhrase,
                        onValueChange = {
                            wakePhrase = it
                            prefs.wakePhrase = it
                        },
                        label = { Text("Wake Phrase") },
                        placeholder = { Text("Hey Aria") },
                        singleLine = true,
                        leadingIcon = {
                            Icon(Icons.Outlined.Mic, contentDescription = null, tint = AriaPrimary)
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = AriaPrimary,
                            unfocusedBorderColor = AriaBorder,
                            focusedTextColor = AriaText,
                            unfocusedTextColor = AriaText,
                            focusedLabelColor = AriaPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    OutlinedTextField(
                        value = sleepPhrase,
                        onValueChange = {
                            sleepPhrase = it
                            prefs.sleepPhrase = it
                        },
                        label = { Text("Sleep Phrase") },
                        placeholder = { Text("Aria, go to sleep") },
                        singleLine = true,
                        leadingIcon = {
                            Icon(Icons.Outlined.Nightlight, contentDescription = null, tint = AriaMutedText)
                        },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = AriaPrimary,
                            unfocusedBorderColor = AriaBorder,
                            focusedTextColor = AriaText,
                            unfocusedTextColor = AriaText,
                            focusedLabelColor = AriaPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        // Silence Timeout
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Outlined.Timer,
                            contentDescription = null,
                            tint = Color(0xFFFFA000),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Silence Sleep Timeout: $silenceTimeout s",
                            fontWeight = FontWeight.SemiBold,
                            color = AriaText,
                            fontSize = 14.sp
                        )
                    }

                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Aria automatically returns to sleep after this period of silence.",
                        fontSize = 12.sp,
                        color = AriaMutedText
                    )

                    Spacer(modifier = Modifier.height(8.dp))
                    Slider(
                        value = silenceTimeout.toFloat(),
                        onValueChange = {
                            silenceTimeout = it.toInt()
                            prefs.silenceTimeoutSeconds = it.toInt()
                        },
                        valueRange = 2f..20f,
                        steps = 17,
                        colors = SliderDefaults.colors(
                            thumbColor = AriaPrimary,
                            activeTrackColor = AriaPrimary
                        )
                    )
                }
            }
        }

        // Start on Boot
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                border = CardDefaults.outlinedCardBorder().copy(
                    brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                ),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(16.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.PowerSettingsNew,
                        contentDescription = null,
                        tint = AriaSuccess,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Start on Boot",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.sp,
                            color = AriaText
                        )
                        Text(
                            text = "Launch assistant automatically when device restarts",
                            fontSize = 12.sp,
                            color = AriaMutedText
                        )
                    }
                    Switch(
                        checked = startOnBoot,
                        onCheckedChange = {
                            startOnBoot = it
                            prefs.startOnBoot = it
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = AriaSuccess,
                            checkedTrackColor = AriaSuccess.copy(alpha = 0.4f)
                        )
                    )
                }
            }
        }
    }
}
