package com.example.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.AriaPreferences
import com.example.model.AriaModel
import com.example.model.LLMProvider
import com.example.model.ProviderType
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import com.example.ui.theme.AriaAccent
import com.example.ui.theme.AriaBorder
import com.example.ui.theme.AriaDarkBackground
import com.example.ui.theme.AriaDarkSurface
import com.example.ui.theme.AriaDarkSurfaceElevated
import com.example.ui.theme.AriaMutedText
import com.example.ui.theme.AriaPinkRedGradient
import com.example.ui.theme.AriaPrimary
import com.example.ui.theme.AriaSecondary
import com.example.ui.theme.AriaText

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ModelsScreen(
    prefs: AriaPreferences,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val providers by prefs.providersState.collectAsState()
    var showAddProviderDialog by remember { mutableStateOf(false) }
    var providerToEdit by remember { mutableStateOf<LLMProvider?>(null) }
    var providerForNewModel by remember { mutableStateOf<LLMProvider?>(null) }
    var assistantName by remember { mutableStateOf(prefs.assistantName) }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .background(AriaDarkBackground)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Header
        item {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                                contentDescription = "Back",
                                tint = AriaText
                            )
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Icon(
                        imageVector = Icons.Default.Psychology,
                        contentDescription = null,
                        tint = AriaPrimary,
                        modifier = Modifier.size(28.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Brain & Providers",
                        style = MaterialTheme.typography.titleLarge,
                        color = AriaText,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Add OpenAI-compatible, Anthropic, or Gemini providers with your own API keys. Aria silently falls back to the next model/provider if any call fails.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AriaMutedText
                )
            }
        }

        // Assistant Name Card
        item {
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Assistant Persona Name",
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                        fontSize = 15.sp
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = assistantName,
                        onValueChange = {
                            assistantName = it
                            prefs.assistantName = it
                        },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFF00E5FF),
                            unfocusedBorderColor = Color(0xFF30363D),
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        // Providers Section Header
        item {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Configured Providers (${providers.size})",
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                        fontSize = 17.sp
                    )
                    Text(
                        text = "Stored with EncryptedSharedPreferences (AES-256)",
                        fontSize = 12.sp,
                        color = Color(0xFF8B949E)
                    )
                }
                Button(
                    onClick = { showAddProviderDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF238636)),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("Add Provider")
                }
            }
        }

        // Empty state
        if (providers.isEmpty()) {
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF161B22).copy(alpha = 0.6f)),
                    border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Color(0xFF30363D)))
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(
                            imageVector = Icons.Default.Cloud,
                            contentDescription = null,
                            tint = Color.Gray,
                            modifier = Modifier.size(48.dp)
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        Text(
                            text = "No Providers Added Yet",
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Tap 'Add Provider' to connect any OpenAI-compatible (OpenRouter, Groq, Ollama), Anthropic Claude, or Gemini key. No built-in models are forced.",
                            fontSize = 13.sp,
                            color = Color(0xFF8B949E),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                        Spacer(modifier = Modifier.height(14.dp))
                        Button(
                            onClick = { showAddProviderDialog = true },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1F6FEB))
                        ) {
                            Text("Add Your First Provider")
                        }
                    }
                }
            }
        } else {
            // Providers list
            items(providers, key = { it.id }) { provider ->
                ProviderCard(
                    provider = provider,
                    onMakeActive = { prefs.setActiveProvider(provider.id) },
                    onDelete = { prefs.removeProvider(provider.id) },
                    onEdit = { providerToEdit = provider },
                    onAddModel = { providerForNewModel = provider },
                    onSelectModel = { modelId ->
                        prefs.setActiveModelInProvider(provider.id, modelId)
                    },
                    onDeleteModel = { modelId ->
                        prefs.removeModelFromProvider(provider.id, modelId)
                    }
                )
            }

            // Silent Fallback explanation card
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF0D1117)),
                    border = CardDefaults.outlinedCardBorder().copy(brush = androidx.compose.ui.graphics.SolidColor(Color(0xFF30363D)))
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Info,
                            contentDescription = null,
                            tint = Color(0xFF58A6FF),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            text = "Silent Fallback: If an active model fails (bad ID, rate limit, quota, timeout, or empty response), Aria automatically cascades through your remaining models and providers without interrupting you or exposing raw errors.",
                            fontSize = 12.sp,
                            color = Color(0xFF8B949E),
                            lineHeight = 16.sp
                        )
                    }
                }
            }
        }
    }

    // Add Provider Dialog
    if (showAddProviderDialog) {
        AddEditProviderDialog(
            existingProvider = null,
            onDismiss = { showAddProviderDialog = false },
            onSave = { nickname, type, baseUrl, apiKey, initialModelId, initialModelNick, supportsImages ->
                val initialModels = if (initialModelId.isNotBlank()) {
                    listOf(
                        AriaModel(
                            id = initialModelId.trim(),
                            nickname = initialModelNick.trim(),
                            supportsImages = supportsImages,
                            isActive = true
                        )
                    )
                } else emptyList()

                prefs.addProvider(
                    nickname = nickname,
                    type = type,
                    baseUrl = baseUrl,
                    apiKey = apiKey,
                    initialModels = initialModels
                )
                showAddProviderDialog = false
            }
        )
    }

    // Edit Provider Dialog
    providerToEdit?.let { provider ->
        AddEditProviderDialog(
            existingProvider = provider,
            onDismiss = { providerToEdit = null },
            onSave = { nickname, type, baseUrl, apiKey, _, _, _ ->
                prefs.updateProvider(
                    provider.copy(
                        nickname = nickname,
                        type = type,
                        baseUrl = baseUrl,
                        apiKey = apiKey
                    )
                )
                providerToEdit = null
            }
        )
    }

    // Add Model to Provider Dialog
    providerForNewModel?.let { provider ->
        AddModelDialog(
            providerName = provider.nickname,
            onDismiss = { providerForNewModel = null },
            onAdd = { modelId, nickname, supportsImages ->
                prefs.addModelToProvider(
                    providerId = provider.id,
                    modelId = modelId,
                    nickname = nickname,
                    supportsImages = supportsImages
                )
                providerForNewModel = null
            }
        )
    }
}

@Composable
private fun ProviderCard(
    provider: LLMProvider,
    onMakeActive: () -> Unit,
    onDelete: () -> Unit,
    onEdit: () -> Unit,
    onAddModel: () -> Unit,
    onSelectModel: (String) -> Unit,
    onDeleteModel: (String) -> Unit
) {
    var isApiKeyVisible by remember { mutableStateOf(false) }

    val typeColor = when (provider.type) {
        ProviderType.OPENAI_COMPATIBLE -> Color(0xFF00E5FF)
        ProviderType.ANTHROPIC -> Color(0xFFD500F9)
        ProviderType.GEMINI -> Color(0xFF448AFF)
    }

    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (provider.isActive) Color(0xFF1C2128) else Color(0xFF161B22)
        ),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = androidx.compose.ui.graphics.SolidColor(
                if (provider.isActive) typeColor.copy(alpha = 0.8f) else Color(0xFF30363D)
            )
        )
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            // Header Row: Type Badge, Nickname, Active Chip, Actions
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(typeColor.copy(alpha = 0.2f))
                        .padding(horizontal = 8.dp, vertical = 3.dp)
                ) {
                    Text(
                        text = provider.type.displayName,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = typeColor
                    )
                }

                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = provider.nickname,
                    fontWeight = FontWeight.Bold,
                    color = Color.White,
                    fontSize = 16.sp,
                    modifier = Modifier.weight(1f)
                )

                if (provider.isActive) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0xFF238636))
                            .padding(horizontal = 8.dp, vertical = 3.dp)
                    ) {
                        Text(
                            text = "ACTIVE",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color.White
                        )
                    }
                } else {
                    OutlinedButton(
                        onClick = onMakeActive,
                        shape = RoundedCornerShape(8.dp),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        modifier = Modifier.height(28.dp)
                    ) {
                        Text("Make Active", fontSize = 11.sp, color = Color(0xFF58A6FF))
                    }
                }

                IconButton(onClick = onEdit, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.Edit, contentDescription = "Edit", tint = Color.LightGray, modifier = Modifier.size(16.dp))
                }

                IconButton(onClick = onDelete, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.DeleteOutline, contentDescription = "Delete", tint = Color(0xFFF85149), modifier = Modifier.size(16.dp))
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Base URL
            Text(
                text = "Endpoint: ${provider.baseUrl}",
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                color = Color(0xFF8B949E)
            )

            // API Key Masked Display
            Spacer(modifier = Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Key: " + if (provider.apiKey.isBlank()) "None set"
                    else if (isApiKeyVisible) provider.apiKey
                    else "••••••••••••••••" + provider.apiKey.takeLast(4),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = if (provider.apiKey.isBlank()) Color(0xFFF85149) else Color(0xFF3FB950),
                    modifier = Modifier.weight(1f)
                )
                if (provider.apiKey.isNotBlank()) {
                    IconButton(
                        onClick = { isApiKeyVisible = !isApiKeyVisible },
                        modifier = Modifier.size(22.dp)
                    ) {
                        Icon(
                            imageVector = if (isApiKeyVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = "Toggle key visibility",
                            tint = Color.Gray,
                            modifier = Modifier.size(14.dp)
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Models section inside this provider
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "Models (${provider.models.size})",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                    modifier = Modifier.weight(1f)
                )
                TextButton(
                    onClick = onAddModel,
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                    modifier = Modifier.height(26.dp)
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp), tint = Color(0xFF58A6FF))
                    Spacer(modifier = Modifier.width(2.dp))
                    Text("Add Model", fontSize = 11.sp, color = Color(0xFF58A6FF))
                }
            }

            if (provider.models.isEmpty()) {
                Text(
                    text = "No models added for this provider. Tap '+ Add Model' to paste a model ID.",
                    fontSize = 12.sp,
                    color = Color.Gray,
                    modifier = Modifier.padding(vertical = 4.dp)
                )
            } else {
                Column(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.padding(top = 4.dp)
                ) {
                    provider.models.forEachIndexed { index, model ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (model.isActive) Color(0xFF21262D) else Color(0xFF0D1117))
                                .clickable { onSelectModel(model.id) }
                                .padding(horizontal = 10.dp, vertical = 6.dp)
                        ) {
                            Icon(
                                imageVector = if (model.isActive) Icons.Default.RadioButtonChecked else Icons.Default.RadioButtonUnchecked,
                                contentDescription = null,
                                tint = if (model.isActive) typeColor else Color.Gray,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = "#${index + 1}",
                                fontSize = 11.sp,
                                color = Color.Gray
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = model.displayName,
                                    fontSize = 13.sp,
                                    fontWeight = if (model.isActive) FontWeight.Bold else FontWeight.Normal,
                                    color = if (model.isActive) Color.White else Color.LightGray
                                )
                                if (model.nickname.isNotBlank() && model.nickname != model.id) {
                                    Text(
                                        text = model.id,
                                        fontSize = 10.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = Color.Gray
                                    )
                                }
                            }

                            if (model.supportsImages) {
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(4.dp))
                                        .background(Color(0xFF388BFD).copy(alpha = 0.2f))
                                        .padding(horizontal = 4.dp, vertical = 2.dp)
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.Default.Image, contentDescription = "Vision", tint = Color(0xFF58A6FF), modifier = Modifier.size(12.dp))
                                        Spacer(modifier = Modifier.width(2.dp))
                                        Text("Vision", fontSize = 9.sp, color = Color(0xFF58A6FF))
                                    }
                                }
                            }

                            IconButton(
                                onClick = { onDeleteModel(model.id) },
                                modifier = Modifier.size(24.dp)
                            ) {
                                Icon(Icons.Default.Close, contentDescription = "Remove", tint = Color.Gray, modifier = Modifier.size(14.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AddEditProviderDialog(
    existingProvider: LLMProvider?,
    onDismiss: () -> Unit,
    onSave: (
        nickname: String,
        type: ProviderType,
        baseUrl: String,
        apiKey: String,
        initialModelId: String,
        initialModelNick: String,
        supportsImages: Boolean
    ) -> Unit
) {
    var nickname by remember { mutableStateOf(existingProvider?.nickname ?: "") }
    var selectedType by remember { mutableStateOf(existingProvider?.type ?: ProviderType.OPENAI_COMPATIBLE) }
    var baseUrl by remember { mutableStateOf(existingProvider?.baseUrl ?: selectedType.defaultBaseUrl) }
    var apiKey by remember { mutableStateOf(existingProvider?.apiKey ?: "") }
    var isKeyVisible by remember { mutableStateOf(false) }

    // Initial model fields (for new provider)
    var initialModelId by remember { mutableStateOf("") }
    var initialModelNick by remember { mutableStateOf("") }
    var supportsImages by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = if (existingProvider != null) "Edit Provider" else "Add AI Provider",
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // Provider Type Selector
                Text("Provider Protocol / Type:", fontSize = 12.sp, color = Color.Gray)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    ProviderType.values().forEach { type ->
                        val isSelected = selectedType == type
                        FilterChip(
                            selected = isSelected,
                            onClick = {
                                selectedType = type
                                if (existingProvider == null) {
                                    baseUrl = type.defaultBaseUrl
                                }
                            },
                            label = { Text(type.displayName.take(8) + "...", fontSize = 11.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = Color(0xFF1F6FEB),
                                selectedLabelColor = Color.White
                            )
                        )
                    }
                }

                // Nickname
                OutlinedTextField(
                    value = nickname,
                    onValueChange = { nickname = it },
                    label = { Text("Nickname (e.g. OpenRouter, DeepSeek, Claude)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                // Base URL
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = { Text("Base URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                // API Key
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text("API Key") },
                    singleLine = true,
                    visualTransformation = if (isKeyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { isKeyVisible = !isKeyVisible }) {
                            Icon(
                                imageVector = if (isKeyVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = null
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )

                // Initial Model (only if creating a brand new provider)
                if (existingProvider == null) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text("Initial Model (Optional):", fontSize = 12.sp, color = Color.Gray)
                    OutlinedTextField(
                        value = initialModelId,
                        onValueChange = { initialModelId = it },
                        label = { Text("Model ID (e.g. openai/gpt-4o, claude-3-5-sonnet)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = initialModelNick,
                        onValueChange = { initialModelNick = it },
                        label = { Text("Nickname (e.g. GPT-4o, Sonnet)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = supportsImages,
                            onCheckedChange = { supportsImages = it }
                        )
                        Text("Model supports images / vision", fontSize = 12.sp, color = Color.White)
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    onSave(
                        nickname.ifBlank { selectedType.displayName },
                        selectedType,
                        baseUrl.ifBlank { selectedType.defaultBaseUrl },
                        apiKey.trim(),
                        initialModelId,
                        initialModelNick,
                        supportsImages
                    )
                },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF238636))
            ) {
                Text(if (existingProvider != null) "Update" else "Add Provider")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = Color.LightGray)
            }
        },
        containerColor = Color(0xFF161B22)
    )
}

@Composable
private fun AddModelDialog(
    providerName: String,
    onDismiss: () -> Unit,
    onAdd: (modelId: String, nickname: String, supportsImages: Boolean) -> Unit
) {
    var modelId by remember { mutableStateOf("") }
    var nickname by remember { mutableStateOf("") }
    var supportsImages by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("Add Model to $providerName", fontWeight = FontWeight.Bold, color = Color.White)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Paste any model ID supported by this provider endpoint.",
                    fontSize = 12.sp,
                    color = Color(0xFF8B949E)
                )
                OutlinedTextField(
                    value = modelId,
                    onValueChange = { modelId = it },
                    label = { Text("Model ID (e.g. meta-llama/llama-3-70b-instruct)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = nickname,
                    onValueChange = { nickname = it },
                    label = { Text("Optional Nickname (e.g. Llama 3 70B)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = supportsImages,
                        onCheckedChange = { supportsImages = it }
                    )
                    Text("Model supports images / screen vision", fontSize = 12.sp, color = Color.White)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (modelId.isNotBlank()) {
                        onAdd(modelId.trim(), nickname.trim(), supportsImages)
                    }
                },
                enabled = modelId.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF238636))
            ) {
                Text("Add Model")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = Color.LightGray)
            }
        },
        containerColor = Color(0xFF161B22)
    )
}
