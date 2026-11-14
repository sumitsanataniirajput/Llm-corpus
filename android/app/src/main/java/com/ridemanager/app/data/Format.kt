package com.ridemanager.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.time.Duration
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val inr: NumberFormat = NumberFormat.getCurrencyInstance(Locale("en", "IN"))
private val dateTimeFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM, h:mm a", Locale.ENGLISH)

/** Money is stored in paise (1 rupee = 100 paise) to avoid rounding errors. */
fun money(paise: Long): String = inr.format(paise / 100.0)

fun parseTime(iso: String?): OffsetDateTime? =
    if (iso.isNullOrBlank() || iso == "null") null else runCatching { OffsetDateTime.parse(iso) }.getOrNull()

fun dateTime(iso: String?): String =
    parseTime(iso)?.atZoneSameInstant(ZoneId.systemDefault())?.format(dateTimeFmt) ?: "—"

fun ago(iso: String?): String {
    val t = parseTime(iso) ?: return "—"
    val s = Duration.between(t, OffsetDateTime.now()).seconds
    return when {
        s < 0 -> dateTime(iso)
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} h ago"
        else -> "${s / 86400} d ago"
    }
}

/** "DRIVER_AT_PICKUP" -> "Driver at pickup" */
fun label(code: String?): String =
    if (code.isNullOrBlank() || code == "null") "—" else code.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }

/** org.json returns the text "null" for JSON null; this returns a real null instead. */
fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
