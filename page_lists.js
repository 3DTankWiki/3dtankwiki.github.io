const pageLists = {
    // 1. 常规页面列表：这些页面会检查最后编辑信息，如果无变化则跳过。
    regular: [
        'Turrets',
        'Hulls',
        'Drones',
        'Protection_Modules',
    ],
    
    // 2. 强制翻译列表：无论内容是否变化，这些页面每次都会被重新翻译和保存。
    forced: [
        'Tanki_Online_Wiki',
        'Help',
    ]
};
