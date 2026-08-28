import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response, status

from .config import SETTINGS
from . import db

SESSION_COOKIE = "luna_session"


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )


def make_password(password: str) -> tuple[str, str]:
    if len(password) < 10:
        raise ValueError("Password must be at least 10 characters.")
    salt = os.urandom(16)
    digest = _hash_password(password, salt)
    return digest.hex(), salt.hex()


def verify_password(password: str, password_hash: str, salt_hex: str) -> bool:
    try:
        digest = _hash_password(password, bytes.fromhex(salt_hex)).hex()
        return hmac.compare_digest(digest, password_hash)
    except Exception:
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def bootstrap_admin():
    """
    The owner/admin is created only from Render environment variables.
    There is deliberately no public signup route.
    """
    if db.user_count() == 0:
        if not SETTINGS.admin_username or not SETTINGS.admin_password:
            print(
                "LUNA PULSE V3.3: No users exist. Set LUNA_ADMIN_USERNAME and "
                "LUNA_ADMIN_PASSWORD in Render Environment, then redeploy."
            )
            return None

        password_hash, salt = make_password(SETTINGS.admin_password)
        admin = db.create_user(
            username=SETTINGS.admin_username,
            display_name=SETTINGS.admin_display_name,
            password_hash=password_hash,
            salt=salt,
            role="admin",
            starting_balance=SETTINGS.starting_balance,
        )
        db.migrate_legacy_to_admin(admin["id"], SETTINGS.starting_balance)
        print(f"LUNA PULSE V3.3: bootstrap admin created: {admin['username']}")
        return admin

    # If an admin already exists, migrate legacy V3 data into the first admin once.
    admins = [u for u in db.list_users() if u["role"] == "admin"]
    if admins:
        db.migrate_legacy_to_admin(admins[0]["id"], SETTINGS.starting_balance)
        return admins[0]
    return None


def login(response: Response, username: str, password: str):
    user = db.get_user_by_username(username.strip())
    if not user or not user.get("active") or not verify_password(
        password, user["password_hash"], user["salt"]
    ):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = secrets.token_urlsafe(48)
    expires = datetime.now(timezone.utc) + timedelta(hours=SETTINGS.session_hours)
    db.create_session(user["id"], _token_hash(token), expires.strftime("%Y-%m-%d %H:%M:%S"))

    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SETTINGS.session_hours * 3600,
        httponly=True,
        secure=SETTINGS.cookie_secure,
        samesite="strict",
        path="/",
    )
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "role": user["role"],
    }


def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.delete_session(_token_hash(token))
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        secure=SETTINGS.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Login required.")
    user = db.get_session_user(_token_hash(token))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired.")
    return user


def admin_user(user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Owner/admin access required.")
    return user
