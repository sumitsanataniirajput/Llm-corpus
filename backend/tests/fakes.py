"""Test doubles for external services.

Only third-party boundaries are replaced:
  * Supabase Storage  -> in-memory bucket (no network)
  * PyTorch           -> not installed in the test image; the worker's
                         `_train_sync` is monkeypatched in worker tests.

Nothing in ``app/`` is replaced: endpoints, SQLAlchemy models, validation and
the worker's database access all run for real.
"""
import sys
import types


class FakeBucket:
    """Minimal Supabase Storage bucket API backed by a dict."""

    def __init__(self, objects, bucket, downloads=None):
        self.objects = objects
        self.bucket = bucket
        self.downloads = downloads if downloads is not None else []

    def upload(self, path, data, file_options=None):
        self.objects[(self.bucket, path)] = bytes(data)
        return {"path": path, "Key": f"{self.bucket}/{path}"}

    def download(self, path):
        key = (self.bucket, path)
        if key not in self.objects:
            raise FileNotFoundError(f"Object not found: {self.bucket}/{path}")
        self.downloads.append({"bucket": self.bucket, "path": path})
        return self.objects[key]

    def create_signed_upload_url(self, path, options=None):
        return {"path": path, "token": "test-signed-token-" + path}

    def info(self, path):
        key = (self.bucket, path)
        if key not in self.objects:
            raise FileNotFoundError(f"Object not found: {self.bucket}/{path}")
        size = len(self.objects[key])
        return {"name": path, "size": size, "metadata": {"size": size}}

    def remove(self, paths):
        removed = []
        for path in paths:
            key = (self.bucket, path)
            if key in self.objects:
                del self.objects[key]
                removed.append({"name": path})
        return removed

    def list(self, prefix=""):
        return [
            {"name": path.split("/")[-1]}
            for (bucket, path) in self.objects
            if bucket == self.bucket and path.startswith(prefix)
        ]


class FakeStorageAPI:
    def __init__(self, objects):
        self.objects = objects
        self.downloads = []

    def from_(self, bucket):
        return FakeBucket(self.objects, bucket, self.downloads)


class FakeSupabaseClient:
    """Stands in for ``supabase.create_client(...)``."""

    def __init__(self):
        self.objects = {}
        self.storage = FakeStorageAPI(self.objects)

    @property
    def downloads(self):
        return self.storage.downloads

    # test helpers ---------------------------------------------------------
    def put(self, bucket, path, data: bytes):
        self.objects[(bucket, path)] = bytes(data)

    def get(self, bucket, path):
        return self.objects[(bucket, path)]

    def paths(self, bucket=None):
        return [path for (b, path) in self.objects if bucket in (None, b)]


def _install_supabase_stub():
    try:
        import supabase

        # NOTE: a bare `import supabase` is not enough. When pytest is invoked
        # from the repository root, the repository's own `supabase/` folder
        # (migrations) is importable as a PEP 420 namespace package and wins
        # over site-packages. That namespace has no `create_client`, so only
        # treat the import as real when the SDK entry point exists.
        if hasattr(supabase, "create_client"):
            return
    except Exception:
        pass

    module = types.ModuleType("supabase")

    def create_client(url, key, *args, **kwargs):  # pragma: no cover - patched in fixtures
        raise RuntimeError(
            "Supabase client is stubbed in tests; patch the endpoint's create_client."
        )

    module.create_client = create_client
    sys.modules["supabase"] = module


def _install_torch_stub():
    try:
        import torch  # noqa: F401
        return False
    except Exception:
        pass

    torch = types.ModuleType("torch")

    class _Anything:
        def __init__(self, *a, **k):
            pass

        def __call__(self, *a, **k):
            return self

        def __getattr__(self, item):
            return _Anything()

    torch.manual_seed = lambda *a, **k: None
    torch.tensor = lambda data, **kwargs: _Anything()
    torch.save = lambda *a, **k: None
    torch.long = "long"
    torch.device = lambda *a, **k: _Anything()
    torch.nn = types.ModuleType("torch.nn")
    torch.nn.Module = type("Module", (), {"__init__": lambda self, *a, **k: None})
    torch.optim = types.ModuleType("torch.optim")
    torch.optim.AdamW = type("AdamW", (), {"__init__": lambda self, *a, **k: None})
    torch.optim.lr_scheduler = types.ModuleType("torch.optim.lr_scheduler")
    torch.optim.lr_scheduler.CosineAnnealingLR = type(
        "CosineAnnealingLR", (), {"__init__": lambda self, *a, **k: None}
    )
    torch.utils = types.ModuleType("torch.utils")
    torch.utils.data = types.ModuleType("torch.utils.data")
    torch.utils.data.DataLoader = type("DataLoader", (), {"__init__": lambda self, *a, **k: None})
    torch.utils.data.TensorDataset = type("TensorDataset", (), {"__init__": lambda self, *a, **k: None})
    torch.utils.data.Dataset = type("Dataset", (), {})
    torch.cuda = types.ModuleType("torch.cuda")
    torch.cuda.is_available = lambda: False
    torch.backends = types.ModuleType("torch.backends")
    torch.backends.mps = types.ModuleType("torch.backends.mps")
    torch.backends.mps.is_available = lambda: False

    sys.modules["torch"] = torch
    sys.modules["torch.nn"] = torch.nn
    sys.modules["torch.optim"] = torch.optim
    sys.modules["torch.optim.lr_scheduler"] = torch.optim.lr_scheduler
    sys.modules["torch.utils"] = torch.utils
    sys.modules["torch.utils.data"] = torch.utils.data
    sys.modules["torch.cuda"] = torch.cuda
    sys.modules["torch.backends"] = torch.backends
    sys.modules["torch.backends.mps"] = torch.backends.mps

    # The real PyTorch model/trainer cannot be constructed without torch.
    # The worker tests monkeypatch `_train_sync`, so only the import must work.
    trainer_module = types.ModuleType("corpus_engine.pytorch_engine.pytorch_trainer")

    class PyTorchTrainer:
        def __init__(self, config, device="cpu"):
            self.config = config
            self.device = device
            self.model = None

        def train_epoch(self, loader, clip_grad=1.0, accum_steps=1):  # pragma: no cover
            return 0.0

    trainer_module.PyTorchTrainer = PyTorchTrainer
    sys.modules["corpus_engine.pytorch_engine.pytorch_trainer"] = trainer_module

    model_module = types.ModuleType("corpus_engine.pytorch_engine.pytorch_model")

    class CorpusTransformerPT:  # pragma: no cover
        def __init__(self, config):
            self.config = config

    model_module.CorpusTransformerPT = CorpusTransformerPT
    sys.modules["corpus_engine.pytorch_engine.pytorch_model"] = model_module
    return True


def install_dependency_stubs():
    _install_supabase_stub()
    _install_torch_stub()
