import base64

from gros_workers.credentials import decrypt_credentials, encrypt_credentials

# Vector produced by the Node implementation (apps/api/src/common/crypto.ts
# encryptSecret) with masterKey='test-master-key' and a fixed IV — pins
# cross-language byte compatibility of scrypt params + AES-GCM blob layout.
NODE_VECTOR_B64 = "AAECAwQFBgcICQoLveumWBv94/tk9yeIigohembqHsCRBm4yKSthhKJIcEtrtgEM9P/bx7l5"


def test_decrypts_node_encrypted_blob() -> None:
    blob = base64.b64decode(NODE_VECTOR_B64)
    creds = decrypt_credentials(blob, master_key="test-master-key")
    assert creds == {"access_token": "tok-123"}


def test_round_trip() -> None:
    creds = {"access_token": "abc", "refresh_token": "def"}
    blob = encrypt_credentials(creds, master_key="another-key")
    assert decrypt_credentials(blob, master_key="another-key") == creds


def test_wrong_key_fails_loudly() -> None:
    blob = encrypt_credentials({"a": "b"}, master_key="key-1")
    try:
        decrypt_credentials(blob, master_key="key-2")
        raise AssertionError("decryption with the wrong key must fail")
    except Exception:
        pass
