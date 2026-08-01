from django.urls import path

urlpatterns = [
    path("items/", item_list),
    path("items/<int:pk>/", item_detail),
]
