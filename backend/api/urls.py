from django.urls import path
from . import views

urlpatterns = [
    path('generate', views.generate, name='generate'),
    path('chat', views.chat, name='chat'),
    path('summarize', views.summarize, name='summarize'),
    path('embeddings', views.embeddings, name='embeddings'),
]
