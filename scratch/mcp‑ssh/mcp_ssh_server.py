from mcp.server.fastmcp import FastMCP
import paramiko
import os
import yaml

# 主机凭据配置文件路径,可用环境变量覆盖,默认 ~/.ssh_mcp_hosts.yaml
HOSTS_FILE = os.getenv("MCP_SSH_HOSTS_FILE", os.path.expanduser("~/.ssh_mcp_hosts.yaml"))

# 兜底默认值(当配置文件不存在或某台没填时用)
DEFAULT_FALLBACK = {
    "host": os.getenv("MCP_SSH_HOST", "127.0.0.1"),
    "port": int(os.getenv("MCP_SSH_PORT", "22")),
    "username": os.getenv("MCP_SSH_USER", "root"),
    "password": os.getenv("MCP_SSH_PASSWORD", ""),
    "private_key_path": os.getenv("MCP_SSH_KEY", "~/.ssh/id_rsa"),
    "private_key_passphrase": os.getenv("MCP_SSH_KEY_PASS", ""),
}


def load_hosts() -> dict:
    """读取 YAML 主机配置,并做 ~ 展开与默认值补全。"""
    if not os.path.exists(HOSTS_FILE):
        return {"default": dict(DEFAULT_FALLBACK)}
    with open(HOSTS_FILE, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    # 补全缺省字段 + 展开 ~
    for name, cfg in data.items():
        merged = dict(DEFAULT_FALLBACK)
        merged.update(cfg or {})
        if "port" in merged and isinstance(merged["port"], str):
            merged["port"] = int(merged["port"])
        if merged.get("private_key_path"):
            merged["private_key_path"] = os.path.expanduser(merged["private_key_path"])
        data[name] = merged
    if "default" not in data:
        data["default"] = dict(DEFAULT_FALLBACK)
    return data


HOSTS = load_hosts()

mcp = FastMCP("ssh‑mcp‑server")


def _connect(cfg: dict):
    """按配置建立 paramiko 连接:优先密钥,其次密码。"""
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = {
        "hostname": cfg["host"],
        "port": cfg["port"],
        "username": cfg["username"],
        "timeout": 12,
    }
    key_path = cfg.get("private_key_path")
    password = cfg.get("password")
    passphrase = cfg.get("private_key_passphrase") or None

    if key_path and os.path.exists(os.path.expanduser(key_path)):
        connect_kwargs["key_filename"] = os.path.expanduser(key_path)
        if passphrase:
            connect_kwargs["passphrase"] = passphrase
    elif password:
        connect_kwargs["password"] = password
    else:
        raise RuntimeError(
            f"主机 {cfg.get('host')} 未配置可用凭据(既无私钥文件也无密码)"
        )
    ssh.connect(**connect_kwargs)
    return ssh


@mcp.tool()
def list_hosts() -> str:
    """
    列出已配置的可连接主机名称(资产清单)。
    仅返回主机键名,不包含任何账号、密码或密钥路径等敏感信息。
    调用 ssh_run_command 时,host 参数填这里的某个名称即可。
    :return: 主机名称列表(每行一个)
    """
    names = [n for n in HOSTS.keys() if n != "default"]
    if "default" in HOSTS:
        names = ["default"] + names
    return "已配置主机:\n" + "\n".join(f"- {n}" for n in names)


@mcp.tool()
def ssh_run_command(
    command: str,
    host: str | None = None,
) -> str:
    """
    在远程SSH服务器执行shell命令
    凭据从 ~/.ssh_mcp_hosts.yaml(可用 MCP_SSH_HOSTS_FILE 覆盖)按 host 名称查表获取,
    无需在调用时传入账号密码。先用 list_hosts 查看可用主机名。
    :param command: 需要执行的shell命令
    :param host: 配置文件中的主机键名(如 web1 / db1),不填使用 default
    :return: 执行结果 stdout+stderr+exitcode
    """
    name = host or "default"
    if name not in HOSTS:
        available = ", ".join(HOSTS.keys())
        return f"错误:未找到主机配置 '{name}',可用主机: {available}"
    cfg = HOSTS[name]

    try:
        ssh = _connect(cfg)
    except Exception as e:
        return f"ssh连接失败({name} -> {cfg['host']}): {str(e)}"

    try:
        stdin, stdout, stderr = ssh.exec_command(command, timeout=12)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode("utf‑8", errors="ignore")
        err = stderr.read().decode("utf‑8", errors="ignore")
        return f"host:{name} exit_code:{exit_code}\nstdout:\n{out}\nstderr:\n{err}"
    except Exception as e:
        return f"ssh执行异常({name}): {str(e)}"
    finally:
        ssh.close()


if __name__ == "__main__":
    mcp.run(transport="stdio")
