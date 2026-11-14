package com.ridemanager.app

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ridemanager.app.data.ApiException
import com.ridemanager.app.data.SessionStore
import com.ridemanager.app.data.SupabaseApi
import com.ridemanager.app.data.dateTime
import com.ridemanager.app.data.objects
import com.ridemanager.app.data.str
import com.ridemanager.app.push.Push
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

enum class Stage { NOT_CONFIGURED, LOADING, SIGNED_OUT, NEEDS_CODE, SIGNED_IN }

data class Staff(val name: String, val email: String, val employeeCode: String, val role: String)

data class UiState(
    val stage: Stage = Stage.LOADING,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val staff: Staff? = null,
    val permissions: Set<String> = emptySet(),
    val appName: String = "Ride Manager",
    val pushStatus: String = "Not checked yet",
)

/** Holds the sign-in state. Screens load their own data through [api] and report failures with [fail]. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    val store = SessionStore(app)
    val api = SupabaseApi(store)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var totpFactorId: String? = null
    private val device = "Android app · ${Build.MANUFACTURER} ${Build.MODEL}".take(80)

    init {
        when {
            !api.configured -> _state.update { it.copy(stage = Stage.NOT_CONFIGURED) }
            store.signedIn && !timedOut() -> viewModelScope.launch { resume() }
            else -> { store.clear(); _state.update { it.copy(stage = Stage.SIGNED_OUT) } }
        }
    }

    fun can(permission: String): Boolean = permission in _state.value.permissions
    fun clearMessages() = _state.update { it.copy(error = null, notice = null) }
    fun notify(text: String) = _state.update { it.copy(notice = text, error = null) }

    /** Shows an error; a lost session sends the user back to the sign-in screen. */
    fun fail(e: Throwable) {
        if (e is ApiException && e.code == "NOT_AUTHENTICATED") {
            store.clear()
            _state.update { UiState(stage = Stage.SIGNED_OUT, error = e.message, appName = it.appName) }
        } else {
            _state.update { it.copy(busy = false, error = e.message ?: "Something went wrong.") }
        }
    }

    // ------------------------------------------------------------ inactivity timeout

    private fun timedOut(): Boolean {
        val last = store.lastActiveAt
        return last > 0 && System.currentTimeMillis() - last > store.timeoutMinutes * 60_000L
    }

    fun touched() { if (_state.value.stage == Stage.SIGNED_IN) store.lastActiveAt = System.currentTimeMillis() }

    /** Called whenever the app returns to the foreground. */
    fun onForeground() {
        if (_state.value.stage == Stage.SIGNED_IN && timedOut()) {
            viewModelScope.launch {
                api.signOut()
                _state.update { UiState(stage = Stage.SIGNED_OUT, notice = "You were signed out after a period of inactivity.", appName = it.appName) }
            }
        }
    }

    // ------------------------------------------------------------ sign-in

    fun signIn(emailInput: String, password: String) {
        val email = emailInput.trim().lowercase()
        if (!Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$").matches(email)) { _state.update { it.copy(error = "Enter a valid e-mail address.") }; return }
        if (password.isEmpty()) { _state.update { it.copy(error = "Enter your password.") }; return }
        _state.update { it.copy(busy = true, error = null, notice = null) }
        viewModelScope.launch {
            try {
                val pre = api.loginPrecheck(email)
                if (!pre.optBoolean("allowed", true)) {
                    throw ApiException(pre.optString("code"), when (pre.optString("code")) {
                        "LOCKED" -> "This account is locked after too many failed sign-ins. Try again after ${dateTime(pre.str("locked_until"))}."
                        "IP_BLOCKED" -> "Sign-in is not allowed from this network."
                        else -> "Too many attempts. Please wait a few minutes and try again."
                    })
                }
                val user = try { api.signIn(email, password) } catch (e: ApiException) {
                    if (e.code == "INVALID_LOGIN") api.recordLoginFailure(email)
                    throw e
                }
                totpFactorId = (user.optJSONArray("factors") ?: JSONArray()).objects()
                    .firstOrNull { it.optString("factor_type") == "totp" && it.optString("status") == "verified" }?.optString("id")
                openSession()
            } catch (e: Exception) {
                if (_state.value.stage != Stage.NEEDS_CODE) store.clear()
                _state.update { it.copy(busy = false, error = e.message ?: "Sign-in failed.") }
            }
        }
    }

    /** Registers the device session on the server, then loads the staff profile and permissions. */
    private suspend fun openSession() {
        val s = api.rpc("begin_session", JSONObject().put("p_device", device)) as? JSONObject ?: JSONObject()
        if (!s.optBoolean("ok")) {
            api.signOut()
            throw ApiException(s.optString("code"), when (s.optString("code")) {
                "NOT_STAFF" -> "This account is not a staff account. The Manager App is for staff only."
                "ACCOUNT_SUSPENDED" -> "This staff account is suspended. Contact your administrator."
                "ACCOUNT_DEACTIVATED" -> "This staff account has been deactivated."
                "IP_BLOCKED" -> "Sign-in is not allowed from this network."
                "LOCKED" -> "This account is locked. Try again after ${dateTime(s.str("locked_until"))}."
                "SESSION_REVOKED" -> "This session was ended by an administrator. Please sign in again."
                else -> "Sign-in was refused (${s.optString("code")})."
            })
        }
        store.timeoutMinutes = s.optInt("session_timeout_min", 30).coerceIn(5, 720)
        if (s.optBoolean("mfa_required") && s.optString("aal") != "aal2") {
            if (totpFactorId == null) {
                api.signOut()
                throw ApiException("MFA_NOT_ENROLLED", "Your account requires two-factor authentication. Sign in once on the web console first: it shows a QR code to set up your authenticator app. Then sign in here.")
            }
            _state.update { it.copy(stage = Stage.NEEDS_CODE, busy = false, error = null) }
            return
        }
        loadAccess()
    }

    fun submitCode(code: String) {
        val factor = totpFactorId
        if (factor == null) { cancelCode(); return }
        if (!Regex("^\\d{6}$").matches(code.trim())) { _state.update { it.copy(error = "Enter the 6-digit code from your authenticator app.") }; return }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                try { api.verifyTotp(factor, code.trim()) } catch (e: ApiException) {
                    runCatching { api.rpc("log_auth_event", JSONObject().put("p_event", "mfa_failed")) }
                    throw e
                }
                runCatching { api.rpc("log_auth_event", JSONObject().put("p_event", "mfa_verified")) }
                openSession()
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, error = e.message ?: "Verification failed.") }
            }
        }
    }

    fun cancelCode() {
        viewModelScope.launch { api.signOut(); _state.update { UiState(stage = Stage.SIGNED_OUT, appName = it.appName) } }
    }

    /** App restart with a stored session: confirm it is still valid on the server. */
    private suspend fun resume() {
        try {
            openSession()
        } catch (e: Exception) {
            // Two-factor sessions cannot be resumed without the factor list: ask for a fresh sign-in.
            store.clear()
            _state.update { UiState(stage = Stage.SIGNED_OUT, error = if (e is ApiException && e.code == "NETWORK") e.message else null) }
        }
    }

    private suspend fun loadAccess() {
        val a = api.rpc("my_access") as? JSONObject ?: JSONObject()
        if (!a.optBoolean("ok")) { api.signOut(); throw ApiException("NO_ACCESS", "Your account has no access. Contact your administrator.") }
        val st = a.optJSONObject("staff") ?: JSONObject()
        val perms = a.optJSONArray("permissions") ?: JSONArray()
        store.lastActiveAt = System.currentTimeMillis()
        _state.update {
            it.copy(
                stage = Stage.SIGNED_IN, busy = false, error = null,
                staff = Staff(st.optString("full_name"), st.optString("email"), st.optString("employee_code"), a.optJSONObject("role")?.optString("name").orEmpty()),
                permissions = (0 until perms.length()).map { i -> perms.optString(i) }.toSet(),
                appName = a.optJSONObject("settings")?.str("brand.app_name") ?: "Ride Manager",
            )
        }
        if (Push.permitted(getApplication())) registerPush()
    }

    fun registerPush() {
        viewModelScope.launch { val status = Push.register(api, store); _state.update { it.copy(pushStatus = status) } }
    }

    fun signOut() {
        _state.update { it.copy(busy = true) }
        viewModelScope.launch { api.signOut(); _state.update { UiState(stage = Stage.SIGNED_OUT, appName = it.appName) } }
    }
}
