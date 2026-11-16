package com.example

import com.example.model.ActionHistoryItem
import com.example.model.MemoryItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class AriaModelsUnitTest {

    @Test
    fun actionHistoryItem_properties() {
        val item = ActionHistoryItem(
            id = "test-1",
            timestamp = 1000L,
            actionType = "TAP",
            description = "Tapped button",
            status = "SUCCESS",
            details = "At (200, 300)"
        )
        assertEquals("test-1", item.id)
        assertEquals("TAP", item.actionType)
        assertEquals("SUCCESS", item.status)
        assertEquals("At (200, 300)", item.details)
    }

    @Test
    fun memoryItem_properties() {
        val mem = MemoryItem(id = "m1", fact = "User prefers concise answers", timestamp = 2000L)
        assertNotNull(mem.id)
        assertEquals("User prefers concise answers", mem.fact)
    }
}
