// Build script: 在 Windows 上嵌入图标和 VERSIONINFO 到 PE 资源
// 其他平台 no-op（避免对非 Windows 构建报错）

fn main() {
    // v0.4.11: Cargo.toml 改了要重 build.rs
    println!("cargo:rerun-if-changed=Cargo.toml");
    // 图标变了就重新跑 build.rs
    println!("cargo:rerun-if-changed=assets/svcctl.ico");
    println!("cargo:rerun-if-changed=build.rs");

    // v0.4.11: build.rs 运行时读 Cargo.toml 的 version（不用 env!("CARGO_PKG_VERSION")）——
    // env! 宏在 build.rs binary 编译时填充，build.rs binary 没改 cargo 不重编它，env 还是旧值。
    // 动态读 Cargo.toml 让 rerun-if-changed=Cargo.toml 真正生效（PE FileVersion 跟 Cargo.toml 同步）
    let version = read_cargo_version().unwrap_or_else(|| {
        eprintln!("[build.rs] WARNING: failed to parse Cargo.toml version, using 0.0.0");
        "0.0.0".to_string()
    });

    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/svcctl.ico");
        // VERSIONINFO 字段：任务管理器属性 / 资源管理器属性页会读这些
        res.set("FileDescription", "SvcCtl");
        res.set("ProductName", "SvcCtl");
        res.set("CompanyName", "茶茶");
        res.set("LegalCopyright", "MIT License");
        // VERSIONINFO 版本字段从 Cargo.toml 单一来源（动态读，rerun 时拿到最新值）
        res.set("FileVersion", &version);
        res.set("ProductVersion", &version);
        // 应用清单（DPI awareness 之类可以加，但 minimal manifest 也够用）
        res.set_manifest(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="0.3.0.0" name="cha133.SvcCtl"/>
</assembly>"#,
        );
        if let Err(e) = res.compile() {
            eprintln!("[build.rs] winres compile failed: {}", e);
            std::process::exit(1);
        }
    }
}

/** 从 Cargo.toml 解析 `version = "X.Y.Z"` 字段（运行时读，不用 env! 宏） */
fn read_cargo_version() -> Option<String> {
    let content = std::fs::read_to_string("Cargo.toml").ok()?;
    for line in content.lines() {
        // 跳过注释行
        let line = line.split('#').next().unwrap_or("");
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("version") {
            // 去掉前导空格和 = 号（如 " = \"0.4.11\"" → "\"0.4.11\""）
            let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
            // value 用双引号包裹
            if let Some(rest) = rest.strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    return Some(rest[..end].to_string());
                }
            }
        }
    }
    None
}
