package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.FlashlightOn
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Message
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.ActionHistoryItem
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaBorderStrong
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaError
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaSuccess
import com.example.ui.theme.AriaText
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun ActivityScreen(
    prefs: AriaPreferences,
    modifier: Modifier = Modifier
) {
    val history by prefs.historyState.collectAsState()
    var selectedFilter by remember { mutableStateOf("ALL") }
    var showClearConfirm by remember { mutableStateOf(false) }

    val filteredHistory = when (selectedFilter) {
        "SAFETY" -> history.filter { it.status == "REFUSED_SAFETY" || it.actionType == "SAFETY_REFUSAL" }
        "TASKS" -> history.filter { it.status == "SUCCESS" }
        else -> history
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Activity Timeline",
                        style = MaterialTheme.typography.headlineSmall,
                        color = AriaText,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "Real-time audit log of tasks, screen reads, and safety actions.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = AriaMutedText
                    )
                }

                if (history.isNotEmpty()) {
                    IconButton(onClick = { showClearConfirm = true }) {
                        Icon(
                            imageVector = Icons.Outlined.DeleteOutline,
                            contentDescription = "Clear History",
                            tint = AriaMutedText
                        )
                    }
                }
            }
        }

        // Filter chips
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(
                    "ALL" to "All Activity",
                    "TASKS" to "Completed Tasks",
                    "SAFETY" to "Safety Decisions"
                ).forEach { (key, label) ->
                    val isSelected = selectedFilter == key
                    FilterChip(
                        selected = isSelected,
                        onClick = { selectedFilter = key },
                        label = { Text(label, fontSize = 12.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = AriaDarkSurfaceElevated,
                            selectedLabelColor = AriaPrimary,
                            containerColor = AriaDarkSurface,
                            labelColor = AriaMutedText
                        ),
                        border = FilterChipDefaults.filterChipBorder(
                            enabled = true,
                            selected = isSelected,
                            borderColor = if (isSelected) AriaPrimary else AriaBorder
                        )
                    )
                }
            }
        }

        if (filteredHistory.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
                    border = CardDefaults.outlinedCardBorder().copy(
                        brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
                    ),
                    modifier = Modifier.fillMaxWidth().padding(top = 20.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Box(
                            modifier = Modifier
                                .size(56.dp)
                                .clip(CircleShape)
                                .background(AriaDarkSurfaceElevated)
                                .border(1.dp, AriaBorder, CircleShape),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.History,
                                contentDescription = null,
                                tint = AriaMutedText,
                                modifier = Modifier.size(28.dp)
                            )
                        }
                        Spacer(modifier = Modifier.height(14.dp))
                        Text(
                            text = "No Activity Recorded",
                            fontWeight = FontWeight.Bold,
                            color = AriaText,
                            fontSize = 16.sp
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Tasks and safety events will appear in this timeline as you interact with Aria.",
                            color = AriaMutedText,
                            fontSize = 13.sp,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                }
            }
        } else {
            items(filteredHistory, key = { it.id }) { item ->
                ActivityTimelineCard(item = item)
            }
        }
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("Clear Activity Timeline?", color = AriaText, fontWeight = FontWeight.Bold) },
            text = { Text("This will permanently clear your audit history log.", color = AriaMutedText) },
            confirmButton = {
                Button(
                    onClick = {
                        prefs.clearHistory()
                        showClearConfirm = false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AriaSecondary)
                ) {
                    Text("Clear All")
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearConfirm = false }) {
                    Text("Cancel", color = AriaText)
                }
            },
            containerColor = AriaDarkSurface
        )
    }
}

@Composable
private fun ActivityTimelineCard(item: ActionHistoryItem) {
    val dateFormatter = remember { SimpleDateFormat("h:mm a · MMM d", Locale.getDefault()) }
    val timeFormatted = remember(item.timestamp) { dateFormatter.format(Date(item.timestamp)) }

    val (icon: ImageVector, iconColor: Color, statusBg: Color, statusText: String) = when (item.status) {
        "REFUSED_SAFETY" -> Quad(Icons.Outlined.Lock, AriaSecondary, AriaSecondary.copy(alpha = 0.2f), "SHIELDED")
        "FAILED" -> Quad(Icons.Outlined.Warning, AriaError, AriaError.copy(alpha = 0.2f), "FAILED")
        "CONFIRMATION_REQUIRED" -> Quad(Icons.Outlined.Security, Color(0xFFFFA000), Color(0x33FFA000), "CONFIRMATION")
        else -> when (item.actionType) {
            "CALL" -> Quad(Icons.Outlined.Call, AriaSuccess, AriaSuccess.copy(alpha = 0.2f), "CALLED")
            "SMS" -> Quad(Icons.Outlined.Message, AriaPrimary, AriaPrimary.copy(alpha = 0.2f), "SENT")
            "FLASHLIGHT" -> Quad(Icons.Outlined.FlashlightOn, Color(0xFFFFB300), Color(0x33FFB300), "FLASHLIGHT")
            "SCREEN_AWARENESS", "SCREEN_READ" -> Quad(Icons.Outlined.Visibility, AriaAccent, AriaAccent.copy(alpha = 0.2f), "READ")
            else -> Quad(Icons.Outlined.TouchApp, AriaSuccess, AriaSuccess.copy(alpha = 0.2f), "SUCCESS")
        }
    }

    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = AriaDarkSurface),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = androidx.compose.ui.graphics.SolidColor(AriaBorder)
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .background(iconColor.copy(alpha = 0.15f))
                    .border(1.dp, iconColor.copy(alpha = 0.4f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = iconColor,
                    modifier = Modifier.size(20.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.description,
                    color = AriaText,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp
                )
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = timeFormatted,
                    fontSize = 11.sp,
                    color = AriaMutedText
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(statusBg)
                    .padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text(
                    text = statusText,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = iconColor
                )
            }
        }
    }
}

private data class Quad<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)
