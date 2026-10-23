import os
from pathlib import Path

def load_env(env_path=None):
    """Reads KEY=value lines from the .env next to these scripts, wherever they are run from.

    Variables already set in the environment win, and values may be wrapped in quotes."""
    env_path = Path(env_path) if env_path else Path(__file__).resolve().parent / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)
