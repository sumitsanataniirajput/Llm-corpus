package com.ridemanager.app.data

import com.ridemanager.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.util.concurrent.TimeUnit

/** An error with a stable code (for logic) and a message that can be shown to the user. */
class ApiException(val code: String, message: String) : Exception(message)

/**
 * Thin client for Supabase (Auth, PostgREST, Edge Functions) using only the public anon key
 * and the signed-in user's token. Every permission is enforced by the server
 * (Row Level Security + permission checks inside database functions); this app holds no secrets.
 */
class SupabaseApi(private val store: SessionStore) {

    private val base = BuildConfig.SUPABASE_URL
    private val anon = BuildConfig.SUPABASE_ANON_KEY
    private val json = "application/json; charset=utf-8".toMediaType()
    private val refreshLock = Mutex()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    val configured: Boolean
        get() = base.startsWith("https://") && anon.isNotEmpty() && !base.contains("YOUR-PROJECT-REF") && !anon.contains("YOUR-ANON")

    // ---------------------------------------------------------------- low level

    private data class Reply(val status: Int, val body: String)

    private suspend fun send(
        method: String, path: String, body: String?, token: String?, prefer: String? = null,
    ): Reply = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(base + path)
            .header("apikey", anon)
            .header("Authorization", "Bearer ${token ?: anon}")
            .header("X-Client-Info", "ride-manager-android/${BuildConfig.VERSION_NAME}")
        if (prefer != null) req.header("Prefer", prefer)
        val payload = body?.toRequestBody(json)
        when (method) {
            "GET" -> req.get()
            "POST" -> req.post(payload ?: "{}".toRequestBody(json))
            "PATCH" -> req.patch(payload ?: "{}".toRequestBody(json))
            else -> throw IllegalArgumentException(method)
        }
        try {
            http.newCall(req.build()).execute().use { Reply(it.code, it.body?.string().orEmpty()) }
        } catch (e: IOException) {
            throw ApiException("NETWORK", "No connection to the server. Check your internet and try again.")
        }
    }

    private fun parse(text: String): Any? =
        if (text.isBlank()) null else try { JSONTokener(text).nextValue() } catch (e: Exception) { text }

    /** Turns any error reply (PostgREST, Auth or Edge Function) into an ApiException with a readable message. */
    private fun failure(reply: Reply): ApiException {
        val o = parse(reply.body) as? JSONObject
        val raw = o?.let {
            it.optString("message").ifEmpty { it.optString("msg") }.ifEmpty { it.optString("error_description") }.ifEmpty { it.optString("error") }
        }.orEmpty()
        val edgeCode = o?.optString("code").orEmpty()
        // Database functions raise "CODE: human message".
        val m = Regex("^([A-Z][A-Z0-9_]{2,40}):?\\s*(.*)$", RegexOption.DOT_MATCHES_ALL).find(raw)
        return when {
            m != null -> ApiException(m.groupValues[1], m.groupValues[2].ifBlank { friendly(m.groupValues[1]) })
            edgeCode.matches(Regex("^[A-Z][A-Z0-9_]{2,40}$")) -> ApiException(edgeCode, raw.ifBlank { friendly(edgeCode) })
            reply.status == 401 -> ApiException("NOT_AUTHENTICATED", "Your session has expired. Please sign in again.")
            reply.status == 403 || edgeCode == "42501" || raw.contains("row-level security") || raw.contains("permission denied") ->
                ApiException("PERMISSION_DENIED", "You do not have permission to do this.")
            reply.status == 404 && reply.body.contains("Function not found", ignoreCase = true) ->
                ApiException("FUNCTION_NOT_DEPLOYED", "This server function is not deployed yet. See documentation/DEPLOYMENT.md.")
            reply.status == 429 -> ApiException("RATE_LIMITED", "Too many attempts. Please wait and try again.")
            else -> ApiException("ERROR", raw.ifBlank { "The server answered with an error (HTTP ${reply.status})." })
        }
    }

    private fun friendly(code: String): String = when (code) {
        "PERMISSION_DENIED" -> "You do not have permission to do this."
        "NOT_AUTHENTICATED" -> "Your session has expired. Please sign in again."
        "RATE_LIMITED", "TOO_SOON" -> "Too many attempts. Please wait and try again."
        "SMS_NOT_CONFIGURED" -> "No SMS provider is configured, so the OTP could not be sent."
        "ALREADY_CHECK_IN" -> "You are already checked in."
        "ALREADY_CHECK_OUT" -> "You are already checked out."
        "NOT_CHECKED_IN" -> "You have not checked in yet."
        else -> code.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
    }

    /** Runs a signed-in request; refreshes the token first when it is about to expire, and once more on HTTP 401. */
    private suspend fun authed(method: String, path: String, body: String? = null, prefer: String? = null): Any? {
        if (!store.signedIn) throw ApiException("NOT_AUTHENTICATED", "Please sign in.")
        if (store.expiresAt - 60 < System.currentTimeMillis() / 1000) refresh()
        var reply = send(method, path, body, store.accessToken, prefer)
        if (reply.status == 401) {
            refresh()
            reply = send(method, path, body, store.accessToken, prefer)
        }
        if (reply.status !in 200..299) throw failure(reply)
        return parse(reply.body)
    }

    private suspend fun refresh() = refreshLock.withLock {
        // Another caller may have refreshed while we waited for the lock.
        if (store.expiresAt - 60 >= System.currentTimeMillis() / 1000) return@withLock
        val rt = store.refreshToken ?: throw ApiException("NOT_AUTHENTICATED", "Please sign in.")
        val reply = send("POST", "/auth/v1/token?grant_type=refresh_token", JSONObject().put("refresh_token", rt).toString(), null)
        if (reply.status !in 200..299) {
            if (reply.status in 400..499) store.clear()      // refresh token revoked or expired
            throw ApiException("NOT_AUTHENTICATED", "Your session has expired. Please sign in again.")
        }
        saveTokens(JSONObject(reply.body))
    }

    private fun saveTokens(o: JSONObject) {
        store.save(o.getString("access_token"), o.getString("refresh_token"), o.optLong("expires_in", 3600), o.optJSONObject("user")?.optString("id"))
    }

    // ---------------------------------------------------------------- auth

    /** Server-side check for lockouts and IP rules before a password is even tried. */
    suspend fun loginPrecheck(email: String): JSONObject {
        val reply = send("POST", "/rest/v1/rpc/login_precheck", JSONObject().put("p_email", email).toString(), null)
        if (reply.status !in 200..299) throw failure(reply)
        return parse(reply.body) as? JSONObject ?: JSONObject().put("allowed", true)
    }

    suspend fun recordLoginFailure(email: String) {
        runCatching { send("POST", "/rest/v1/rpc/record_login_failure", JSONObject().put("p_email", email).toString(), null) }
    }

    /** Password sign-in. Returns the Auth user object (it lists the enrolled two-factor devices). */
    suspend fun signIn(email: String, password: String): JSONObject {
        val reply = send("POST", "/auth/v1/token?grant_type=password", JSONObject().put("email", email).put("password", password).toString(), null)
        if (reply.status !in 200..299) {
            if (reply.status == 400 || reply.status == 401) throw ApiException("INVALID_LOGIN", "The e-mail or password is not correct.")
            throw failure(reply)
        }
        val o = JSONObject(reply.body)
        saveTokens(o)
        return o.optJSONObject("user") ?: JSONObject()
    }

    /** Verifies a 6-digit authenticator code; on success the session is upgraded to two-factor level (aal2). */
    suspend fun verifyTotp(factorId: String, code: String) {
        val challenge = authed("POST", "/auth/v1/factors/$factorId/challenge", "{}") as? JSONObject
            ?: throw ApiException("ERROR", "Could not start two-factor verification.")
        val reply = send("POST", "/auth/v1/factors/$factorId/verify",
            JSONObject().put("challenge_id", challenge.getString("id")).put("code", code).toString(), store.accessToken)
        if (reply.status !in 200..299) throw ApiException("INVALID_CODE", "That code is not correct or has expired. Try the next code.")
        saveTokens(JSONObject(reply.body))
    }

    suspend fun signOut() {
        runCatching { rpc("end_session") }
        runCatching { send("POST", "/auth/v1/logout?scope=local", "{}", store.accessToken) }
        store.clear()
    }

    // ---------------------------------------------------------------- data

    /** Calls a database function. Returns JSONObject, JSONArray, a primitive, or null. */
    suspend fun rpc(name: String, args: JSONObject = JSONObject()): Any? = authed("POST", "/rest/v1/rpc/$name", args.toString())

    /** Reads rows. [query] is a PostgREST query string, for example "select=id,name&status=eq.open&order=created_at.desc&limit=20". */
    suspend fun select(table: String, query: String): JSONArray = authed("GET", "/rest/v1/$table?$query") as? JSONArray ?: JSONArray()

    /** Updates the rows matching [filter] (for example "id=eq.<uuid>") and returns them. An empty result means nothing was allowed to change. */
    suspend fun update(table: String, filter: String, values: JSONObject): JSONArray =
        authed("PATCH", "/rest/v1/$table?$filter", values.toString(), "return=representation") as? JSONArray ?: JSONArray()

    suspend fun upsert(table: String, onConflict: String, values: JSONObject) {
        authed("POST", "/rest/v1/$table?on_conflict=$onConflict", values.toString(), "resolution=merge-duplicates,return=minimal")
    }

    /** Calls an Edge Function. A business refusal ({ ok:false, code, message }) is thrown as ApiException. */
    suspend fun function(name: String, body: JSONObject): JSONObject {
        val o = authed("POST", "/functions/v1/$name", body.toString()) as? JSONObject ?: JSONObject()
        if (o.has("ok") && !o.optBoolean("ok")) throw ApiException(o.optString("code", "ERROR"), o.optString("message", "The request was refused."))
        return o
    }
}
