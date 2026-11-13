import os
import tempfile

# every test keeps the bridge's own files in a scratch folder, never in the owner's real one
os.environ.setdefault("AAD_DATA_DIR", tempfile.mkdtemp(prefix="aad-test-"))
