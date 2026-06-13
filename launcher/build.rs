// Build script: 在 Windows 上嵌入图标和 VERSIONINFO 到 PE 资源
// 其他平台 no-op（避免对非 Windows 构建报错）

fn main() {
    // 图标变了就重新跑 build.rs
    println!("cargo:rerun-if-changed=assets/svcctl.ico");
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/svcctl.ico");
        // VERSIONINFO 字段：任务管理器属性 / 资源管理器属性页会读这些
        res.set("FileDescription", "SvcCtl");
        res.set("ProductName", "SvcCtl");
        res.set("CompanyName", "茶茶");
        res.set("LegalCopyright", "MIT License");
        // VERSIONINFO 版本字段从 Cargo.toml 单一来源（winres 也自动从 package.version
        // 读 0.3.0 填 VS_FIXEDFILEINFO.dwFileVersion / dwProductVersion）
        res.set("FileVersion", env!("CARGO_PKG_VERSION"));
        res.set("ProductVersion", env!("CARGO_PKG_VERSION"));
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
