import os
import io
import sys
import pandas as pd
from pathlib import Path
import urllib.request
import json
from config import settings

def run_code_interpreter(query: str, csv_paths: list[str]) -> str:
    dfs_info = ""
    for idx, path in enumerate(csv_paths):
        safe_path = path.replace(chr(92), '/')
        dfs_info += f"df_{idx} = pd.read_csv(r\"\"\"{safe_path}\"\"\")\n"

    prompt = f"""You are a Python Data Analyst. 
The user wants to know: "{query}"
The following CSV files are available and can be loaded as pandas DataFrames:
{dfs_info}

Write ONLY the python code to calculate the answer and print the final result.
Do NOT include markdown formatting like ```python, just the raw code.
Example:
import pandas as pd
{dfs_info}print(df_0['fare'].mean())
"""
    
    url = f"{settings.online_base_url}/chat/completions"
    payload = {
        "model": settings.online_model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 300,
        "temperature": 0.0
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.openai_api_key}",
            "User-Agent": "EvidenceAI/1.0",
        },
        method="POST"
    )

    print("DEBUG URL:", url)
    print("DEBUG MODEL:", settings.online_model)
    print("DEBUG API KEY:", settings.openai_api_key[:10] + "...")

    try:
        with urllib.request.urlopen(req, timeout=settings.online_timeout) as res:
            body = res.read().decode("utf-8")
            response_json = json.loads(body)
            code = response_json["choices"][0]["message"]["content"].strip()
            
        if code.startswith('```python'):
            code = code[9:]
        if code.startswith('```'):
            code = code[3:]
        if code.endswith('```'):
            code = code[:-3]
        code = code.strip()

        # Capture output
        old_stdout = sys.stdout
        sys.stdout = buffer = io.StringIO()
        try:
            # We provide a safe global context
            exec(code, {"pd": pd, "Path": Path, "os": os})
            output = buffer.getvalue().strip()
            if not output:
                output = "Code executed successfully but printed nothing."
            return f"**Data Analysis Result:**\n\n```\n{output}\n```"
        except Exception as e:
            return f"**Error executing code:**\n\n```\n{e}\n```"
        finally:
            sys.stdout = old_stdout
            
    except Exception as e:
        return f"**Error connecting to LLM for code generation:**\n\n```\n{e}\n```"
