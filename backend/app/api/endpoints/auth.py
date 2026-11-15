"""CORPUS ULTIMATE — Authentication endpoints.

Session verification and user profile via Supabase JWT.
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_current_user, require_user

router = APIRouter()


class UserOut(BaseModel):
    user_id: str
    email: Optional[str] = None

    class Config:
        from_attributes = True


@router.get("/me", response_model=UserOut, tags=["auth"])
async def me(user=Depends(require_user)):
    """Get current authenticated user."""
    return UserOut(user_id=user["user_id"], email=user.get("email"))


@router.get("/verify", tags=["auth"])
async def verify(user=Depends(require_user)):
    """Verify session is still valid."""
    return {"valid": True, "user_id": user["user_id"], "email": user.get("email")}