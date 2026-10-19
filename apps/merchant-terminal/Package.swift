// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NuclearTerminalKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NuclearTerminalKit", targets: ["NuclearTerminalKit"]),
    ],
    targets: [
        .target(name: "NuclearTerminalKit"),
        .testTarget(name: "NuclearTerminalKitTests", dependencies: ["NuclearTerminalKit"]),
    ]
)
